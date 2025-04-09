import dotenv from "dotenv";
import ccxt from "ccxt";
import ololog from "ololog";
import ansicolor from "ansicolor";
import astable from "as-table";
import ms from "pretty-ms";

dotenv.config();

const c = ansicolor.nice;
const table = astable.configure({
	title: (x) => x.dim,
	delimiter: " | ".dim.cyan,
	dash: "-".dim.cyan,
});
const log = ololog.configure({
	locate: false,
	time: false,
});

const env = process.env;
const apikey = env.APIKEY || "";
const secret = env.SECRET || "";
const exchange = env.EXCHANGE || "binance";
const asset = env.ASSET || "FLOKI";
const base = env.BASE || "USDT";
const fee = env.FEE || "BNB";
const ordersGap = env.ORDERS_GAP || 0;
const ordersMax = env.ORDERS_MAX || 2;
const ordersAmountPercent = env.ORDERS_AMOUNT_PERCENT || 0.05;
const spreadPercent = env.SPREAD_PERCENT || 0.0025;

const updateTicks = 5;
const tickerTicks = 10;
const symbol = `${asset}/${base}`;
const feeRequiredPercent = 0.1;
const feeSymbol = `${fee}/${base}`;
const failInterval = 5 * 1000;
const updateInterval = 5 * 1000;
const decimals = 2;

const startingBalance = 68.47306996;
const startTime = 1744193036287;

function averageProfit(start, profit) {
	return profit / (runtime(start) / (1000 * 60 * 60 * 24));
}

function runtime(start) {
	return Date.now() - start;
}

while (true) {
	if (apikey == "" || secret == "") {
		log.red("NO APIKEY OR SECRET");
		break;
	}
	try {
		const ex = new ccxt[exchange]({
			apiKey: apikey,
			secret: secret,
			enableRateLimit: true,
			options: {
				defaultType: "margin",
			},
		});

		const params = {
			marginMode: "cross",
		};

		let tick = 0;
		let btcTicker = await ex.fetchTicker(`BTC/${base}`);
		let feeTicker = await ex.fetchTicker(feeSymbol);
		while (true) {
			tick++;
			try {
				let balance = await ex.fetchBalance();
				let ticker = await ex.fetchTicker(symbol);

				if (tick % tickerTicks == 0) {
					try {
						btcTicker = await ex.fetchTicker(`BTC/${base}`);
						feeTicker = await ex.fetchTicker(feeSymbol);
					} catch (err) {
						log.red("failed to update btc and fee tickers");
					}
				}

				let balanceNetBtc = balance.info.totalNetAssetOfBtc;
				let netBalance = (balanceNetBtc * btcTicker.bid).toFixed(decimals);
				let profitBalance = (netBalance - startingBalance).toFixed(decimals);
				let profitPercent = (profitBalance / startingBalance) * 100;
				let profitPercentFixed = profitPercent.toFixed(decimals);

				let profitAverage = averageProfit(startTime, profitPercent).toFixed(
					decimals,
				);

				let midPrice = (ticker.bid + ticker.ask) / 2;
				let spread = midPrice * spreadPercent;
				let balanceBase = balance.free[base] || 0;
				let balanceAsset = balance.free[asset] || 0;
				let balanceFee = balance.free[fee] || 0;

				let orderAmount = ex.amountToPrecision(
					symbol,
					(netBalance * ordersAmountPercent) / midPrice,
				);

				let feeRequired = Math.max(netBalance * feeRequiredPercent, 5.5);
				let balanceFeeRequired = feeRequired / feeTicker.ask;
				let balanceBaseRequired = orderAmount * midPrice * 1.1;
				let balanceAssetRequired = orderAmount * 1.1;

				let marginLevel = parseFloat(balance.info.marginLevel).toFixed(
					decimals,
				);

				let uptime = runtime(startTime);
				try {
					if (tick % updateTicks == 0) {
						let strUptime = ms(uptime);
						let strStartingBalance = `${startingBalance.toFixed(decimals)} ${base}`;
						let strNetBalance = `${netBalance} ${base}`;
						let strProfitBalance = `${profitBalance} ${base}`;
						let strProfitPercent = `${profitPercentFixed}%`;
						let strProfitAverage = `${profitAverage}%`;
						let strMarginLevel = `${marginLevel}`;

						if (profitBalance > 0) {
							strProfitBalance = `+${strProfitBalance}`.green;
						} else {
							strProfitBalance = strProfitBalance.red;
						}

						if (profitPercent > 0) {
							strProfitPercent = `+${strProfitPercent}`.green;
						} else {
							strProfitPercent = strProfitPercent.red;
						}

						if (profitAverage > 0) {
							strProfitAverage = `+${strProfitAverage}`.green;
						} else {
							strProfitAverage = strProfitAverage.red;
						}

						if (marginLevel > 20) {
							strMarginLevel = strMarginLevel.green;
						} else if (marginLevel > 10) {
							strMarginLevel = strMarginLevel.cyan;
						} else if (marginLevel > 3) {
							strMarginLevel = strMarginLevel.orange;
						} else {
							strMarginLevel = strMarginLevel.red;
						}

						let data = table([
							{
								"uptime (human)": strUptime,
								"balance (start)": strStartingBalance,
								"balance (net)": strNetBalance,
								"profit (net)": strProfitBalance,
								"profit %": strProfitPercent,
								"profit/day % ": strProfitAverage,
								"margin level": strMarginLevel,
							},
						]);
						let line = data.split("\n")[1];
						log(line);
						log(data);
						log(line);
					}
				} catch (err) {}

				if (balanceFee < balanceFeeRequired * feeRequiredPercent) {
					await ex.borrowMargin(base, feeRequired, feeSymbol, params);
					log.cyan(`borrow ${base} ${feeRequired}`);

					await ex.createMarketBuyOrder(
						feeSymbol,
						ex.amountToPrecision(feeSymbol, balanceFeeRequired),
					);
					log.cyan(`buy ${fee} ${balanceFeeRequired}`);
					await new Promise((resolve) => setTimeout(resolve, updateInterval)); // Check every 5 seconds
					continue;
				}

				for (const margin of balance.info.userAssets) {
					if (margin.asset == fee) {
						let repayAmountAsset = Math.min(margin.free, margin.interest);
						if (repayAmountAsset > 0) {
							try {
								await ex.repayMargin(
									margin.asset,
									repayAmountAsset,
									symbol,
									params,
								);
								log.green(`paid interest ${margin.asset} ${repayAmountAsset}`);
							} catch (err) {}
						}
					}
					if (margin.asset == asset || margin.asset == base) {
						if (margin.free > 0 && margin.borrowed > 0) {
							let repayAmountAsset = Math.min(margin.free, margin.borrowed);
							if (repayAmountAsset > 0) {
								try {
									await ex.repayMargin(
										margin.asset,
										repayAmountAsset,
										symbol,
										params,
									);
									log.green(`paid margin ${margin.asset} ${repayAmountAsset}`);
								} catch (err) {}
							}
						}
					}
				}

				let buyPrice = ex.priceToPrecision(
					symbol,
					midPrice - (ordersGap + 1) * spread,
				);

				let sellPrice = ex.priceToPrecision(
					symbol,
					midPrice + (ordersGap + 1) * spread,
				);

				let orders = [];
				let hasSell = false;
				let hasBuy = false;
				let openOrders = await ex.fetchOpenOrders(symbol);
				for (const order of openOrders) {
					let buyMax = Math.max(order.price, buyPrice);
					let buyMin = Math.min(order.price, buyPrice);
					let buyGap = buyMax - buyMin;
					if (buyGap <= spread) {
						hasBuy = true;
					}
					let sellMax = Math.max(order.price, sellPrice);
					let sellMin = Math.min(order.price, sellPrice);
					let sellGap = sellMax - sellMin;
					if (sellGap <= spread) {
						hasSell = true;
					}
				}

				if (!hasBuy) {
					if (balanceBase < balanceBaseRequired) {
						balanceBaseRequired = ex.priceToPrecision(
							symbol,
							balanceBaseRequired - balanceBase,
						);

						if (balanceBaseRequired > 0) {
							try {
								await ex.borrowMargin(
									base,
									balanceBaseRequired,
									symbol,
									params,
								);
								log.yellow(`borrow ${base} ${balanceBaseRequired}`);
							} catch (err) {}
						}
					}

					orders.push(
						ex.createLimitOrder(symbol, "buy", orderAmount, buyPrice, params),
					);
				}

				if (!hasSell) {
					if (balanceAsset < balanceAssetRequired) {
						balanceAssetRequired = ex.amountToPrecision(
							symbol,
							balanceAssetRequired - balanceAsset,
						);
						if (balanceAssetRequired > 0) {
							try {
								await ex.borrowMargin(
									asset,
									balanceAssetRequired,
									symbol,
									params,
								);
								log.yellow(`borrow ${asset} ${balanceAssetRequired}`);
							} catch (err) {}
						}
					}

					orders.push(
						ex.createLimitOrder(symbol, "sell", orderAmount, sellPrice),
					);
				}

				for (const orderReq of orders) {
					try {
						let order = await orderReq;
						openOrders.push(order);
						log.green(`create ${order.side} ${order.amount} @ ${order.price}`);
					} catch (err) {}
				}

				let minOrder;
				let maxOrder;
				let buyCount = 0;
				let sellCount = 0;
				for (const order of openOrders) {
					if (!minOrder || order.price < minOrder.price) {
						minOrder = order;
					}
					if (!maxOrder || order.price > maxOrder.price) {
						maxOrder = order;
					}

					if (order.side == "buy") {
						buyCount++;
					} else {
						sellCount++;
					}
				}

				if (sellCount > ordersMax) {
					try {
						let order = maxOrder;
						await ex.cancelOrder(order.id, symbol);
						log.yellow(`cancel ${order.side} ${order.amount} @ ${order.price}`);
					} catch (err) {
						log.red(err);
					}
				}

				if (buyCount > ordersMax) {
					try {
						let order = minOrder;
						await ex.cancelOrder(order.id, symbol);
						log.yellow(`cancel ${order.side} ${order.amount} @ ${order.price}`);
					} catch (err) {
						log.red(err);
					}
				}
			} catch (err) {
				log.red(err);
				await new Promise((resolve) => setTimeout(resolve, failInterval)); // Check every 5 seconds
			}
		}
	} catch (err) {
		log.red(err);
	}

	await new Promise((resolve) => setTimeout(resolve, failInterval)); // Check every 5 seconds
}
