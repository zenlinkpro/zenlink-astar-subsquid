import { CommonHandlerContext, EvmLogHandlerContext } from "@subsquid/substrate-processor";
import { Store } from "@subsquid/typeorm-store";
import { Big as BigDecimal } from 'big.js'
import * as pairAbi from '../abis/pair'
import { ADDRESS_ZERO, ZERO_BD } from "../consts";
import { getPair } from "../entities/pair";
import { getBundle, getFactory, getPosition, getTransaction } from "../entities/utils";
import {
  Bundle,
  Burn,
  LiquidityPosition,
  LiquidityPositionSnapshot,
  Mint,
  Pair,
  Swap,
  Token,
  Transaction,
  User
} from "../model";
import { convertTokenToDecimal, createLiquidityPosition } from "../utils/helpers";
import { findEthPerToken, getEthPriceInUSD, MINIMUM_USD_THRESHOLD_NEW_PAIRS, WHITELIST } from "../utils/pricing";
import { updatePairDayData, updatePairHourData, updateTokenDayData, updateZenlinkDayData } from "../utils/updates";

const transferEventAbi = pairAbi.events['Transfer(address,address,uint256)']
const syncEventAbi = pairAbi.events['Sync(uint112,uint112)']
const SwapAbi = pairAbi.events['Swap(address,uint256,uint256,uint256,uint256,address)']
const MintAbi = pairAbi.events['Mint(address,uint256,uint256)']
const BurnAbi = pairAbi.events['Burn(address,uint256,uint256,address)']

async function isCompleteMint(ctx: CommonHandlerContext<Store>, mintId: string): Promise<boolean> {
  return !!(await ctx.store.get(Mint, mintId))?.sender // sufficient checks
}

export async function handleTransfer(ctx: EvmLogHandlerContext<Store>): Promise<void> {
  const contractAddress = ctx.event.args.address

  const data = transferEventAbi.decode(ctx.event.args)
  // ignore initial transfers for first adds
  if (data.to === ADDRESS_ZERO && data.value.toBigInt() === 1000n) {
    return
  }
  const transactionHash = ctx.event.evmTxHash

  // user stats
  const { from } = data
  const { to } = data

  // get pair and load contract
  const pair = await getPair(ctx, contractAddress)

  // liquidity token amount being transfered
  const value = convertTokenToDecimal(data.value.toBigInt(), 18)

  // get or create transaction
  let transaction = await getTransaction(ctx, ctx.event.evmTxHash)
  if (transaction == null) {
    transaction = new Transaction({
      id: transactionHash,
      blockNumber: ctx.block.height,
      timestamp: new Date(ctx.block.timestamp),
      mints: [],
      burns: [],
      swaps: [],
    })
    await ctx.store.save(transaction)
  }

  const { mints } = transaction

  // mints
  if (from === ADDRESS_ZERO) {
    pair.totalSupply = BigDecimal(pair.totalSupply).plus(value).toString()

    if (mints.length || await isCompleteMint(ctx, mints[mints.length - 1])) {
      const mint = new Mint({
        id: `${transactionHash}-${mints.length}`,
        transaction,
        pair,
        to,
        liquidity: value.toString(),
        timestamp: new Date(ctx.block.timestamp)
      })
      await ctx.store.save(mint)
      transaction.mints = mints.concat([mint.id])
      await ctx.store.save(transaction)
    }
  }

  // burn
  if (to === ADDRESS_ZERO && from === pair.id) {
    pair.totalSupply = BigDecimal(pair.totalSupply).minus(value).toString()

    const { burns } = transaction
    let burn: Burn
    if (burns.length > 0) {
      const currentBurn = await ctx.store.get(Burn, burns[burns.length - 1])
      if (currentBurn?.needsComplete) {
        burn = currentBurn
      } else {
        burn = new Burn({
          id: `${transactionHash}-${burns.length}`,
          transaction,
          needsComplete: false,
          pair,
          liquidity: value.toString(),
          timestamp: new Date(ctx.block.timestamp)
        })
      }
    } else {
      burn = new Burn({
        id: `${transactionHash}-${burns.length}`,
        transaction,
        needsComplete: false,
        pair,
        liquidity: value.toString(),
        timestamp: new Date(ctx.block.timestamp)
      })
    }

    // if this logical burn included a fee mint, account for this
    if (mints.length !== 0 && !await isCompleteMint(ctx, mints[mints.length - 1])) {
      const mint = await ctx.store.get(Mint, mints[mints.length - 1])
      if (mint) {
        burn.feeTo = mint.to
        burn.feeLiquidity = mint.liquidity
      }

      await ctx.store.remove(Mint, mints[mints.length - 1])
      mints.pop()
      transaction.mints = mints
    }
    await ctx.store.save(burn)
    if (burn.needsComplete) {
      // TODO: Consider using .slice(0, -1).concat() to protect against
      // unintended side effects for other code paths.
      burns[burns.length - 1] = burn.id
    } else {
      burns.push(burn.id)
    }
    transaction.burns = burns
    await ctx.store.save(transaction)
  }

  if (from !== ADDRESS_ZERO && from !== pair.id) {
    let user = await ctx.store.get(User, from)
    if (!user) {
      user = new User({
        id: from,
        liquidityPositions: [],
        usdSwapped: ZERO_BD.toString()
      })
    }
    const position = await updateLiquidityPosition(ctx, pair, user)
    const pairContract = new pairAbi.Contract(ctx, contractAddress)
    position.liquidityTokenBalance = convertTokenToDecimal(
      (await pairContract.balanceOf(from)).toBigInt(),
      18
    ).toString()
    await ctx.store.save(position)
    await createLiquiditySnapShot(ctx, position)
  }

  if (to !== ADDRESS_ZERO && to !== pair.id) {
    let user = await ctx.store.get(User, to)
    if (!user) {
      user = new User({
        id: to,
        liquidityPositions: [],
        usdSwapped: ZERO_BD.toString()
      })
    }
    const position = await updateLiquidityPosition(ctx, pair, user)
    const pairContract = new pairAbi.Contract(ctx, contractAddress)
    position.liquidityTokenBalance = convertTokenToDecimal(
      (await pairContract.balanceOf(to)).toBigInt(),
      18
    ).toString()
    await ctx.store.save(position)
    await createLiquiditySnapShot(ctx, position)
  }

  await ctx.store.save(pair)
}

async function updateLiquidityPosition(
  ctx: CommonHandlerContext<Store>,
  pair: Pair,
  user: User
): Promise<LiquidityPosition> {
  let position = await getPosition(ctx, `${pair.id}-${user.id}`)
  if (!position) {
    position = createLiquidityPosition({
      pair,
      user
    })

    await ctx.store.save(position)

    pair.liquidityProviderCount += 1
  }
  return position
}

async function createLiquiditySnapShot(
  ctx: CommonHandlerContext<Store>,
  position: LiquidityPosition
): Promise<void> {
  const { timestamp } = ctx.block
  const bundle = await ctx.store.get(Bundle, '1')
  const pair = await ctx.store.get(Pair, position.pair.id)
  if (!pair || !bundle) return
  const token0 = await ctx.store.get(Token, pair.token0.id)
  const token1 = await ctx.store.get(Token, pair.token1.id)
  if (!token0 || !token1) return

  // create new snapshot
  const snapshot = new LiquidityPositionSnapshot({
    id: `${position.id}${timestamp}`,
    liquidityPosition: position,
    timestamp: new Date(timestamp),
    block: ctx.block.height,
    user: position.user,
    pair: position.pair,
    token0PriceUSD: BigDecimal(token0.derivedETH).times(BigDecimal(bundle.ethPrice)).toString(),
    token1PriceUSD: BigDecimal(token1.derivedETH).times(BigDecimal(bundle.ethPrice)).toString(),
    reserve0: pair.reserve0,
    reserve1: pair.reserve1,
    reserveUSD: pair.reserveUSD,
    liquidityTokenTotalSupply: pair.totalSupply,
    liquidityTokenBalance: position.liquidityTokenBalance,
  })
  await ctx.store.save(snapshot)
}

export async function handleSync(ctx: EvmLogHandlerContext<Store>): Promise<void> {
  const contractAddress = ctx.event.args.address

  const data = syncEventAbi.decode(ctx.event.args)
  const bundle = await getBundle(ctx)
  const factory = await getFactory(ctx)
  const pair = await getPair(ctx, contractAddress)
  const { token0, token1 } = pair

  factory.totalLiquidityETH = BigDecimal(factory.totalLiquidityETH)
    .minus(BigDecimal(pair.trackedReserveETH))
    .toString()
  token0.totalLiquidity = BigDecimal(token0.totalLiquidity)
    .minus(BigDecimal(pair.reserve0))
    .toString()
  token1.totalLiquidity = BigDecimal(token1.totalLiquidity)
    .minus(BigDecimal(pair.reserve1))
    .toString()

  pair.reserve0 = convertTokenToDecimal(data.reserve0.toBigInt(), token0.decimals).toString()
  pair.reserve1 = convertTokenToDecimal(data.reserve1.toBigInt(), token0.decimals).toString()
  pair.token0Price = !BigDecimal(pair.reserve1).eq(ZERO_BD)
    ? BigDecimal(pair.reserve0).div(pair.reserve1).toString()
    : ZERO_BD.toString()
  pair.token1Price = !BigDecimal(pair.reserve0).eq(ZERO_BD)
    ? BigDecimal(pair.reserve1).div(pair.reserve0).toString()
    : ZERO_BD.toString()
  await ctx.store.save(pair)

  // update ETH price now that reserves could have changed
  bundle.ethPrice = (await getEthPriceInUSD(ctx)).toString()
  await ctx.store.save(bundle)

  token0.derivedETH = (await findEthPerToken(ctx, token0.id)).toString()
  token1.derivedETH = (await findEthPerToken(ctx, token1.id)).toString()

  let trackedLiquidityETH = ZERO_BD
  if (!BigDecimal(bundle.ethPrice).eq(ZERO_BD)) {
    const price0 = BigDecimal(token0.derivedETH).times(bundle.ethPrice)
    const price1 = BigDecimal(token1.derivedETH).times(bundle.ethPrice)

    // both are whitelist tokens, take average of both amounts
    if (WHITELIST.includes(token0.id) && WHITELIST.includes(token1.id)) {
      trackedLiquidityETH = BigDecimal(pair.reserve0).times(price0).plus(BigDecimal(pair.reserve1).times(price1))
    }

    // take double value of the whitelisted token amount
    if (WHITELIST.includes(token0.id) && !WHITELIST.includes(token1.id)) {
      trackedLiquidityETH = BigDecimal(pair.reserve0).times(price0).times(2)
    }

    // take double value of the whitelisted token amount
    if (!WHITELIST.includes(token0.id) && WHITELIST.includes(token1.id)) {
      trackedLiquidityETH = BigDecimal(pair.reserve1).times(price1).times(2)
    }

    trackedLiquidityETH = trackedLiquidityETH.div(bundle.ethPrice)
  }

  pair.trackedReserveETH = trackedLiquidityETH.toString()
  pair.reserveETH = BigDecimal(pair.reserve0)
    .times(token0.derivedETH)
    .plus(BigDecimal(pair.reserve1).times(token1.derivedETH))
    .toString()
  pair.reserveUSD = BigDecimal(pair.reserveETH).times(bundle.ethPrice).toString()
  await ctx.store.save(pair)

  // use tracked amounts globally
  factory.totalLiquidityETH = BigDecimal(factory.totalLiquidityETH).plus(trackedLiquidityETH).toString()
  factory.totalLiquidityUSD = BigDecimal(factory.totalLiquidityETH).plus(bundle.ethPrice).toString()
  await ctx.store.save(factory)

  // now correctly set liquidity amounts for each token
  token0.totalLiquidity = BigDecimal(token0.totalLiquidity).plus(pair.reserve0).toString()
  token1.totalLiquidity = BigDecimal(token1.totalLiquidity).plus(pair.reserve1).toString()
  await ctx.store.save([token0, token1])
}

export async function handleSwap(ctx: EvmLogHandlerContext<Store>): Promise<void> {
  const contractAddress = ctx.event.args.address

  const data = SwapAbi.decode(ctx.event.args)
  const bundle = await getBundle(ctx)
  const factory = await getFactory(ctx)

  const pair = await getPair(ctx, contractAddress)

  const { token0, token1 } = pair

  const amount0In = convertTokenToDecimal(data.amount0In.toBigInt(), token0.decimals)
  const amount0Out = convertTokenToDecimal(data.amount0Out.toBigInt(), token0.decimals)
  const amount0Total = amount0Out.plus(amount0In)

  const amount1In = convertTokenToDecimal(data.amount1In.toBigInt(), token1.decimals)
  const amount1Out = convertTokenToDecimal(data.amount1Out.toBigInt(), token1.decimals)
  const amount1Total = amount1Out.plus(amount1In)

  // get total amounts of derived USD and ETH for tracking
  const derivedAmountETH = BigDecimal(token1.derivedETH)
    .times(amount1Total)
    .plus(BigDecimal(token0.derivedETH).times(amount0Total))
    .div(2)
  const derivedAmountUSD = derivedAmountETH.times(bundle.ethPrice)
  // only accounts for volume through white listed tokens

  let trackedAmountUSD = ZERO_BD
  const price0 = BigDecimal(token0.derivedETH).times(bundle.ethPrice)
  const price1 = BigDecimal(token1.derivedETH).times(bundle.ethPrice)

  const reserve0USD = BigDecimal(pair.reserve0).times(price0)
  const reserve1USD = BigDecimal(pair.reserve1).times(price1)

  // if less than 5 LPs, require high minimum reserve amount amount or return 0
  if (
    pair.liquidityProviderCount < 5 &&
    ((WHITELIST.includes(token0.id) &&
      WHITELIST.includes(token1.id) &&
      reserve0USD.plus(reserve1USD).lt(MINIMUM_USD_THRESHOLD_NEW_PAIRS)) ||
      (WHITELIST.includes(token0.id) &&
        !WHITELIST.includes(token1.id) &&
        reserve0USD.times(2).lt(MINIMUM_USD_THRESHOLD_NEW_PAIRS)) ||
      (!WHITELIST.includes(token0.id) &&
        WHITELIST.includes(token1.id) &&
        reserve1USD.times(2).lt(MINIMUM_USD_THRESHOLD_NEW_PAIRS)))
  ) {
    // do nothing
  } else {
    // both are whitelist tokens, take average of both amounts
    if (WHITELIST.includes(token0.id) && WHITELIST.includes(token1.id)) {
      trackedAmountUSD = amount0Total.times(price0).plus(amount1Total.times(price1)).div(2)
    }

    // take full value of the whitelisted token amount
    if (WHITELIST.includes(token0.id) && !WHITELIST.includes(token1.id)) {
      trackedAmountUSD = amount0Total.times(price0)
    }

    // take full value of the whitelisted token amount
    if (!WHITELIST.includes(token0.id) && WHITELIST.includes(token1.id)) {
      trackedAmountUSD = amount1Total.times(price1)
    }
  }

  const trackedAmountETH = BigDecimal(bundle.ethPrice).eq(ZERO_BD)
    ? ZERO_BD
    : trackedAmountUSD.div(bundle.ethPrice)
  // update token0 global volume and token liquidity stats
  token0.tradeVolume = BigDecimal(token0.tradeVolume).plus(amount0Total).toString()
  token0.tradeVolumeUSD = BigDecimal(token0.tradeVolumeUSD).plus(trackedAmountUSD).toString()
  token0.untrackedVolumeUSD = BigDecimal(token0.untrackedVolumeUSD).plus(derivedAmountUSD).toString()
  token0.txCount += 1
  // update token1 global volume and token liquidity stats
  token1.tradeVolume = BigDecimal(token1.tradeVolume).plus(amount1Total).toString()
  token1.tradeVolumeUSD = BigDecimal(token1.tradeVolumeUSD).plus(trackedAmountUSD).toString()
  token1.untrackedVolumeUSD = BigDecimal(token1.untrackedVolumeUSD).plus(derivedAmountUSD).toString()
  token1.txCount += 1
  await ctx.store.save([token0, token1])

  // update pair volume data, use tracked amount if we have it as its probably more accurate
  pair.volumeUSD = BigDecimal(pair.volumeUSD).plus(trackedAmountUSD).toString()
  pair.volumeToken0 = BigDecimal(pair.volumeToken0).plus(amount0Total).toString()
  pair.volumeToken1 = BigDecimal(pair.volumeToken1).plus(amount1Total).toString()
  pair.untrackedVolumeUSD = BigDecimal(pair.untrackedVolumeUSD).plus(derivedAmountUSD).toString()
  pair.txCount += 1
  await ctx.store.save(pair)

  // update global values, only used tracked amounts for volume
  factory.totalVolumeUSD = BigDecimal(factory.totalVolumeUSD).plus(trackedAmountUSD).toString()
  factory.totalVolumeETH = BigDecimal(factory.totalVolumeETH).plus(trackedAmountETH).toString()
  factory.untrackedVolumeUSD = BigDecimal(factory.untrackedVolumeUSD).plus(derivedAmountUSD).toString()
  factory.txCount += 1
  await ctx.store.save(factory)

  let transaction = await getTransaction(ctx, ctx.event.evmTxHash)
  if (transaction == null) {
    transaction = new Transaction({
      id: ctx.event.evmTxHash,
      blockNumber: ctx.block.height,
      timestamp: new Date(ctx.block.timestamp),
      mints: [],
      swaps: [],
      burns: [],
    })
    await ctx.store.save(transaction)
  }
  const swapId = `${transaction.id}-${transaction.swaps.length}`

  transaction.swaps.push(swapId)
  await ctx.store.save(transaction)

  const swap = new Swap({
    id: swapId,
    transaction,
    pair,
    timestamp: new Date(ctx.block.timestamp),
    amount0In: amount0In.toString(),
    amount1In: amount1In.toString(),
    amount0Out: amount0Out.toString(),
    amount1Out: amount1Out.toString(),
    sender: data.sender.toLowerCase(),
    to: data.to.toLowerCase(),
    logIndex: ctx.event.indexInBlock,
    amountUSD: trackedAmountUSD.eq(ZERO_BD)
      ? derivedAmountUSD.toString()
      : trackedAmountUSD.toString(),
  })

  await ctx.store.save(swap)

  const pairDayData = await updatePairDayData(ctx)
  const pairHourData = await updatePairHourData(ctx)
  const zenlinkDayData = await updateZenlinkDayData(ctx)
  const token0DayData = await updateTokenDayData(ctx, token0)
  const token1DayData = await updateTokenDayData(ctx, token1)

  // swap specific updating
  zenlinkDayData.dailyVolumeUSD = BigDecimal(zenlinkDayData.dailyVolumeUSD).plus(trackedAmountUSD).toString()
  zenlinkDayData.dailyVolumeETH = BigDecimal(zenlinkDayData.dailyVolumeETH).plus(trackedAmountETH).toString()
  zenlinkDayData.dailyVolumeUntracked = BigDecimal(zenlinkDayData.dailyVolumeUntracked).plus(derivedAmountUSD).toString()
  await ctx.store.save(zenlinkDayData)

  // swap specific updating for pair
  pairDayData.dailyVolumeToken0 = BigDecimal(pairDayData.dailyVolumeToken0).plus(amount0Total).toString()
  pairDayData.dailyVolumeToken1 = BigDecimal(pairDayData.dailyVolumeToken1).plus(amount1Total).toString()
  pairDayData.dailyVolumeUSD = BigDecimal(pairDayData.dailyVolumeUSD).plus(trackedAmountUSD).toString()
  await ctx.store.save(pairDayData)

  pairHourData.hourlyVolumeToken0 = BigDecimal(pairHourData.hourlyVolumeToken0).plus(amount0Total).toString()
  pairHourData.hourlyVolumeToken1 = BigDecimal(pairHourData.hourlyVolumeToken1).plus(amount1Total).toString()
  pairHourData.hourlyVolumeUSD = BigDecimal(pairHourData.hourlyVolumeUSD).plus(trackedAmountUSD).toString()
  await ctx.store.save(pairHourData)

  // swap specific updating for token0
  token0DayData.dailyVolumeToken = BigDecimal(token0DayData.dailyVolumeToken).plus(amount0Total).toString()
  token0DayData.dailyVolumeETH = BigDecimal(token0DayData.dailyVolumeETH).plus(amount0Total.times(token0.derivedETH)).toString()
  token0DayData.dailyVolumeUSD = BigDecimal(token0DayData.dailyVolumeUSD).plus(
    amount0Total.times(token0.derivedETH).times(bundle.ethPrice)
  ).toString()
  await ctx.store.save(token0DayData)

  // swap specific updating
  token1DayData.dailyVolumeToken = BigDecimal(token1DayData.dailyVolumeToken).plus(amount1Total).toString()
  token1DayData.dailyVolumeETH = BigDecimal(token1DayData.dailyVolumeETH).plus(amount1Total.times(token1.derivedETH)).toString()
  token1DayData.dailyVolumeUSD = BigDecimal(token1DayData.dailyVolumeUSD).plus(
    amount1Total.times(token1.derivedETH).times(bundle.ethPrice)
  ).toString()
  await ctx.store.save(token1DayData)
}

export async function handleMint(ctx: EvmLogHandlerContext<Store>): Promise<void> {
  const transaction = await ctx.store.get(Transaction, ctx.event.evmTxHash)
  // safety check
  if (!transaction) return
  const { mints } = transaction
  const mint = (await ctx.store.get(Mint, mints[mints.length - 1]))!
  const contractAddress = ctx.event.args.address

  const data = MintAbi.decode(ctx.event.args)
  const factory = await getFactory(ctx)
  const pair = await getPair(ctx, contractAddress)

  const { token0, token1 } = pair
  token0.txCount += 1
  token1.txCount += 1

  // update exchange info (except balances, sync will cover that)
  const token0Amount = convertTokenToDecimal(data.amount0.toBigInt(), token0.decimals)
  const token1Amount = convertTokenToDecimal(data.amount1.toBigInt(), token1.decimals)

  const bundle = (await ctx.store.get(Bundle, '1'))!
  const amountTotalUSD = BigDecimal(token1.derivedETH)
    .times(token1Amount)
    .plus(BigDecimal(token0.derivedETH).times(token0Amount))
    .times(bundle.ethPrice)

  pair.txCount += 1
  factory.txCount += 1

  await ctx.store.save(token0)
  await ctx.store.save(token1)
  await ctx.store.save(pair)
  await ctx.store.save(factory)

  mint.sender = data.sender
  mint.amount0 = token0Amount.toString()
  mint.amount1 = token1Amount.toString()
  mint.logIndex = ctx.event.indexInBlock
  mint.amountUSD = amountTotalUSD.toString()
  await ctx.store.save(mint)

  const user = (await ctx.store.get(User, mint.to))!
  // update the LP position
  const liquidityPosition = createLiquidityPosition({ pair, user })
  await createLiquiditySnapShot(ctx, liquidityPosition)

  // update day entities
  await updatePairDayData(ctx)
  await updatePairHourData(ctx)
  await updateZenlinkDayData(ctx)
  await updateTokenDayData(ctx, token0)
  await updateTokenDayData(ctx, token1)
}

export async function handleBurn(ctx: EvmLogHandlerContext<Store>): Promise<void> {
  const transaction = await ctx.store.get(Transaction, ctx.event.evmTxHash)
  if (!transaction) return
  const { burns } = transaction
  const burn = (await ctx.store.get(Burn, burns[burns.length - 1]))!
  const contractAddress = ctx.event.args.address

  const data = BurnAbi.decode(ctx.event.args)

  const factory = await getFactory(ctx)

  const pair = await getPair(ctx, contractAddress)

  // update txn counts
  pair.txCount += 1

  // update txn counts
  factory.txCount += 1

  // update txn counts
  const {token0, token1} = pair
  token0.txCount += 1
  token1.txCount += 1
  const token0Amount = convertTokenToDecimal(data.amount0.toBigInt(), token0.decimals)
  const token1Amount = convertTokenToDecimal(data.amount1.toBigInt(), token1.decimals)

  const bundle = (await ctx.store.get(Bundle, '1'))!
  const amountTotalUSD = BigDecimal(token1.derivedETH)
    .times(token1Amount)
    .plus(BigDecimal(token0.derivedETH).times(token0Amount))
    .times(bundle.ethPrice)
  
  const user = (await ctx.store.get(User, data.sender))!
  await updateLiquidityPosition(ctx, pair, user)

  await ctx.store.save(factory)
  await ctx.store.save(pair)
  await ctx.store.save([token0, token1])

  burn.sender = data.sender
  burn.to = data.to
  burn.amount0 = token0Amount.toString()
  burn.amount1 = token1Amount.toString()
  burn.logIndex = ctx.event.indexInBlock
  burn.amountUSD = amountTotalUSD.toString()
  await ctx.store.save(burn)

  // update the LP position
  const liquidityPosition = createLiquidityPosition({ pair, user })
  await createLiquiditySnapShot(ctx, liquidityPosition)

  // update day entities
  await updatePairDayData(ctx)
  await updatePairHourData(ctx)
  await updateZenlinkDayData(ctx)
  await updateTokenDayData(ctx, token0)
  await updateTokenDayData(ctx, token1)
}

