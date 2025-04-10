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
const asset = env.ASSET || "PEPE";
const base = env.BASE || "USDT";
const ordersMax = env.ORDERS_MAX || 4;
const ordersAmountPercent = env.ORDERS_AMOUNT_PERCENT || 0.1;
const spreadPercent = env.SPREAD_PERCENT || 0.003;

const symbol = `${asset}/${base}`;
const updateTicks = 5;
const failInterval = 5 * 1000;
const decimals = 2;

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
		const ex = new ccxt.bybit({
			apiKey: apikey,
			secret: secret,
			enableRateLimit: true,
			options: {
				defaultType: "unified",
			},
		});

		const params = {
			isLeverage: 1,
		};

		let tick = 0;
		while (true) {
			tick++;
			try {
				let balance = await ex.fetchBalance();
				let ticker = await ex.fetchTicker(symbol);

				let midPrice = (ticker.bid + ticker.ask) / 2;
				let spread = midPrice * spreadPercent;
				let balanceNet = parseFloat(balance.info.result.list[0].totalEquity);

				if (!data?.timestamp || !data?.balance || !data?.symbol) {
					data.timestamp = Date.now();
					data.balance = balanceNet;
					data.symbol = symbol;
					await write(data);
				}

				let profitBalance = (balanceNet - data.balance).toFixed(decimals);
				let profitPercent = ((profitBalance / data.balance) * 100).toFixed(
					decimals,
				);
				let profitAverage = averageProfit(
					data.timestamp,
					profitPercent,
				).toFixed(decimals);

				let orderAmount = ex.amountToPrecision(
					symbol,
					(balanceNet * ordersAmountPercent) / midPrice,
				);

				let uptime = runtime(data.timestamp);
				try {
					if (tick % updateTicks == 0) {
						let strUptime = ms(uptime);
						let strBalanceNet = `${balanceNet.toFixed(decimals)} ${base}`;
						let strBalanceStart = `${data.balance.toFixed(decimals)} ${base}`;
						let strProfitBalance = `${profitBalance} ${base}`;
						let strProfitPercent = `${profitPercent}%`;
						let strProfitAverage = `${profitAverage}%`;

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

						let tbl = table([
							{
								"uptime (human)": strUptime,
								"balance (start)": strBalanceStart,
								"balance (net)": strBalanceNet,
								"profit (net)": strProfitBalance,
								"profit %": strProfitPercent,
								"profit/day % ": strProfitAverage,
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

				let openOrders = await ex.fetchOpenOrders(symbol);
				if (openOrders.length > ordersMax) {
					continue;
				}

				await ex.cancelAllOrders(symbol);

				let orders = [];
				for (let index = 1; index <= ordersMax; index++) {
					{
						let side = "buy";
						let amount = orderAmount;
						let price = ex.priceToPrecision(symbol, midPrice - index * spread);
						orders.push({
							symbol: symbol,
							side: side,
							amount: amount,
							price: price,
							promise: ex.createLimitOrder(symbol, side, amount, price, params),
						});
					}

					{
						let side = "sell";
						let amount = orderAmount;
						let price = ex.priceToPrecision(symbol, midPrice + index * spread);
						orders.push({
							symbol: symbol,
							side: side,
							amount: amount,
							price: price,
							promise: ex.createLimitOrder(symbol, side, amount, price, params),
						});
					}
				}

				for (const order of orders) {
					try {
						await order.promise;
						log.green(`create ${order.side} ${order.amount} @ ${order.price}`);
					} catch (err) {}
				}
			} catch (err) {
				log.red(err);
				await new Promise((resolve) => setTimeout(resolve, failInterval));
			}
		}
	} catch (err) {
		log.red(err);
	}

	await new Promise((resolve) => setTimeout(resolve, failInterval));
}
