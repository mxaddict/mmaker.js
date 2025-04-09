import ansicolor from "ansicolor";
import astable from "as-table";
import ccxt from "ccxt";
import dotenv from "dotenv";
import ms from "pretty-ms";
import ololog from "ololog";
import { readFile, writeFile } from "node:fs/promises";

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
const ordersMax = env.ORDERS_MAX || 2;
const ordersAmountPercent = env.ORDERS_AMOUNT_PERCENT || 0.05;
const spreadPercent = env.SPREAD_PERCENT || 0.003;

const updateTicks = 5;
const tickerTicks = 10;
const symbol = `${asset}/${base}`;
const feeRequiredPercent = 0.1;
const feeSymbol = `${fee}/${base}`;
const failInterval = 5 * 1000;
const updateInterval = 5 * 1000;
const decimals = 2;
const sats = 8;

const dataFile = ".data.json";

const averageProfit = (start, profit) => {
	return profit / (runtime(start) / (1000 * 60 * 60 * 24));
};

const runtime = (start) => {
	return Date.now() - start;
};

const read = async () => {
	try {
		const fileContent = await readFile(dataFile, "utf-8");
		return JSON.parse(fileContent);
	} catch (error) {}
	return {};
};

const write = async (data) => {
	try {
		const jsonData = JSON.stringify(data, null, 2);
		await writeFile(dataFile, jsonData, "utf-8");
	} catch (error) {
		log.red(`An unexpected error occurred during writing: ${error}`);
	}
};

while (true) {
	if (apikey == "" || secret == "") {
		log.red("NO APIKEY OR SECRET");
		break;
	}

	let data = await read();

	if (data?.symbol != symbol) {
		data = {};
		await write(data);
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

				let midPrice = (ticker.bid + ticker.ask) / 2;
				let spread = midPrice * spreadPercent;
				let balanceBase = balance.free[base] || 0;
				let balanceAsset = balance.free[asset] || 0;
				let balanceFee = balance.free[fee] || 0;

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

				if (!data?.timestamp || !data?.balance || !data?.symbol) {
					data.timestamp = Date.now();
					data.balance = parseFloat(netBalance);
					data.symbol = symbol;
					await write(data);
				}

				let profitBalance = (netBalance - data.balance).toFixed(decimals);
				let profitPercent = (profitBalance / data.balance) * 100;
				let profitPercentFixed = profitPercent.toFixed(decimals);

				let profitAverage = averageProfit(
					data.timestamp,
					profitPercent,
				).toFixed(decimals);

				let orderAmount = ex.amountToPrecision(
					symbol,
					(netBalance * ordersAmountPercent) / midPrice,
				);

				let feeRequired = Math.max(netBalance * feeRequiredPercent, 5.5);
				let balanceFeeRequired = feeRequired / feeTicker.ask;
				let balanceBaseRequired = orderAmount * midPrice * 1.5;
				let balanceAssetRequired = orderAmount * 1.5;

				let marginLevel = parseFloat(balance.info.marginLevel).toFixed(
					decimals,
				);

				let uptime = runtime(data.timestamp);
				try {
					if (tick % updateTicks == 0) {
						let strUptime = ms(uptime);
						let strStartingBalance = `${data.balance.toFixed(decimals)} ${base}`;
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
							strMarginLevel = strMarginLevel.yellow;
						} else {
							strMarginLevel = strMarginLevel.red;
						}

						let tbl = table([
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
						let line = tbl.split("\n")[1];
						log(line);
						log(tbl);
						log(line);
					}
				} catch (err) {
					log.red(err);
				}

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
								log.green(
									`paid interest ${margin.asset} ${repayAmountAsset.toFixed(sats)}`,
								);
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

				let buyPrice = ex.priceToPrecision(symbol, midPrice - 1 * spread);

				let sellPrice = ex.priceToPrecision(symbol, midPrice + 1 * spread);

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
