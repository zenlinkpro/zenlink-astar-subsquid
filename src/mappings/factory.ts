import { EvmLogHandlerContext } from "@subsquid/substrate-processor";
import { Store } from "@subsquid/typeorm-store";
import { Bundle, Factory, Pair } from "../model";
import * as factoryAbi from '../abis/factory'
import { ZERO_BD } from "../consts";
import { getOrCreateToken } from "../entities/token";

export async function handleNewPair(ctx: EvmLogHandlerContext<Store>) {
  const contractAddress = ctx.event.args.address

  const data = factoryAbi.events['PairCreated(address,address,address,uint256)']
    .decode(ctx.event.args)

  // load factory (create if first exchange)
  let factory = await ctx.store.get(Factory, contractAddress)
  if (!factory) {
    factory = new Factory({
      id: contractAddress,
      pairCount: 0,
      totalVolumeETH: ZERO_BD.toString(),
      totalLiquidityETH: ZERO_BD.toString(),
      totalVolumeUSD: ZERO_BD.toString(),
      untrackedVolumeUSD: ZERO_BD.toString(),
      totalLiquidityUSD: ZERO_BD.toString(),
      txCount: 0,
    })

    // create new bundle
    const bundle = new Bundle({
      id: '1',
      ethPrice: ZERO_BD.toString(),
    })
    await ctx.store.save(bundle)
  }
  factory.pairCount += 1
  await ctx.store.save(factory)

  // create the tokens
  const token0 = await getOrCreateToken(ctx, data.token0.toLowerCase())
  const token1 = await getOrCreateToken(ctx, data.token1.toLowerCase())

  const pair = new Pair({
    id: data.pair.toLowerCase(),
    token0,
    token1,
    liquidityProviderCount: 0,
    createdAtTimestamp: new Date(ctx.block.timestamp),
    createdAtBlockNumber: ctx.block.height,
    txCount: 0,
    reserve0: ZERO_BD.toString(),
    reserve1: ZERO_BD.toString(),
    trackedReserveETH: ZERO_BD.toString(),
    reserveETH: ZERO_BD.toString(),
    reserveUSD: ZERO_BD.toString(),
    totalSupply: ZERO_BD.toString(),
    volumeToken0: ZERO_BD.toString(),
    volumeToken1: ZERO_BD.toString(),
    volumeUSD: ZERO_BD.toString(),
    untrackedVolumeUSD: ZERO_BD.toString(),
    token0Price: ZERO_BD.toString(),
    token1Price: ZERO_BD.toString(),
  })

  await ctx.store.save(pair)
}
