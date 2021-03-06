/*jslint node: true */
'use strict';
const constants = require('ocore/constants.js');
const conf = require('ocore/conf');
const db = require('ocore/db');
const eventBus = require('ocore/event_bus.js');
const texts = require('./modules/texts.js');
const db_migrations = require('./db_migrations.js');
const db_migrations2 = require('./db_migrations2.js');
const validationUtils = require('ocore/validation_utils');
const notifications = require('./modules/notifications');
const conversion = require('./modules/conversion.js');
const smartidApi = require('./modules/smartid_api.js');
const jumioApi = require('./modules/jumio_api.js');
const serviceHelper = require('./modules/service_helper.js');
const realNameAttestation = require('./modules/real_name_attestation.js');
const reward = require('./modules/reward.js');
const contract = require('./modules/contract.js');
const discounts = require('./modules/discounts.js');
const voucher = require('./modules/voucher.js');
const express = require('express');
const bodyParser = require('body-parser');
const app = express();
const server = require('http').Server(app);
const maxmind = require('maxmind');
const mutex = require('ocore/mutex.js');

const PRICE_TIMEOUT = 3*24*3600; // in seconds

let countryLookup = maxmind.openSync('../GeoLite2-Country.mmdb');

let assocAskedForDonation = {};

function readUserInfo(device_address, cb) {
	db.query("SELECT device_address, user_address, service_provider FROM users WHERE device_address = ?", [device_address], rows => {
		if (rows.length)
			cb(rows[0]);
		else {
			db.query("INSERT "+db.getIgnore()+" INTO users (device_address) VALUES(?)", [device_address], () => {
				cb({
					device_address: device_address,
					user_address: null,
					service_provider: null
				});
			});
		}
	});
}

function readOrAssignReceivingAddress(device_address, user_address, service_provider, cb){
	mutex.lock([device_address], unlock => {
		db.query(
			"SELECT receiving_address, "+db.getUnixTimestamp('last_price_date')+" AS price_ts \n\
			FROM receiving_addresses WHERE device_address=? AND user_address=? AND service_provider=?", 
			[device_address, user_address, service_provider], 
			rows => {
				if (rows.length > 0){
					let row = rows[0];
				//	if (row.price_ts < Date.now()/1000 - 3600)
				//		row.service_provider = null;
					cb(row.receiving_address);
					return unlock();
				}
				const headlessWallet = require('headless-obyte');
				headlessWallet.issueNextMainAddress(receiving_address => {
					db.query(
						"INSERT INTO receiving_addresses (device_address, user_address, service_provider, receiving_address, post_publicly) VALUES(?,?,?,?,0)",
						[device_address, user_address, service_provider, receiving_address],
						() => {
							cb(receiving_address);
							unlock();
						}
					);
				});
			}
		);
	});
}

function updatePrice(receiving_address, price, cb){
	db.query("UPDATE receiving_addresses SET price=?, last_price_date="+db.getNow()+" WHERE receiving_address=?", [price, receiving_address], () => {
		if (cb)
			cb();
	});
}

function moveFundsToAttestorAddresses(){
	let network = require('ocore/network.js');
	if (network.isCatchingUp())
		return;
	console.log('moveFundsToAttestorAddresses');
	db.query(
		"SELECT DISTINCT receiving_address \n\
		FROM receiving_addresses CROSS JOIN outputs ON receiving_address=address JOIN units USING(unit) \n\
		WHERE is_stable=1 AND is_spent=0 AND asset IS NULL \n\
		LIMIT ?",
		[constants.MAX_AUTHORS_PER_UNIT],
		rows => {
			if (rows.length === 0)
				return;
			let arrAddresses = rows.map(row => row.receiving_address);
			let headlessWallet = require('headless-obyte');
			let timestampMod = Date.now()%3;
			headlessWallet.sendMultiPayment({
				asset: null,
				to_address: realNameAttestation.assocAttestorAddresses[timestampMod === 2 ? 'jumio' : (timestampMod === 1 ? 'smartid' : 'nonus')],
				send_all: true,
				paying_addresses: arrAddresses
			}, (err, unit) => {
				if (err)
					console.log("failed to move funds: "+err);
				else
					console.log("moved funds, unit "+unit);
			});
		}
	);
}

//app.use(express.static(__dirname + '/public'));
app.use(bodyParser.urlencoded({ extended: false })); 
app.set('trust proxy', true); // get remote address when using proxy

app.post('*/cb', function(req, res) {
	let body = req.body;
	console.error('received callback', body);
	if (!body.jumioIdScanReference){
		notifications.notifyAdmin("cb without jumioIdScanReference", JSON.stringify(body));
		return res.send(JSON.stringify({result: 'error', error: "no jumioIdScanReference"}));
	}
	db.query(
		"SELECT transaction_id, scan_result FROM transactions WHERE jumioIdScanReference=?", 
		[body.jumioIdScanReference], 
		rows => {
			if (rows.length === 0){
				notifications.notifyAdmin("cb jumioIdScanReference not found", JSON.stringify(body));
				return res.send(JSON.stringify({result: 'error', error: "jumioIdScanReference not found"}));
			}
			let row = rows[0];
			if (row.scan_result !== null){
				notifications.notifyAdmin("duplicate cb", JSON.stringify(body));
				return res.send(JSON.stringify({result: 'error', error: "duplicate cb"}));
			}
			handleJumioData(row.transaction_id, body);
			res.send('ok');
		}
	);
});

app.get('*/done', handleSmartIdCallback);
app.post('*/done', handleSmartIdCallback);
	
function handleSmartIdCallback(req, res) {
	let query = req.query;
	console.error('received request', query);
	if (!query.code || !query.state){
		notifications.notifyAdmin("done without code or state", JSON.stringify(query));
		return res.send("no code or state");
	}
	db.query(
		"SELECT transaction_id, scan_result FROM transactions WHERE jumioIdScanReference=?", 
		[query.state], 
		rows => {
			if (rows.length === 0){
				notifications.notifyAdmin("done state invalid", JSON.stringify(query));
				return res.sendFile(__dirname+'/failed.html');
			}
			let row = rows[0];
			if (row.scan_result !== null){
				// when user refreshes
				//notifications.notifyAdmin("duplicate done", JSON.stringify(query));
				return res.sendFile(__dirname+'/done.html');
			}
			smartidApi.getAccessToken(query.code, function(err, auth) {
				if (err) {
					console.error('getAccessToken', err, auth);
					return res.sendFile(__dirname+'/failed.html');
				}
				else if (auth && auth.access_token) {
					smartidApi.getUserData(auth.access_token, function(err, body) {
						if (body) {
							body.clientIp = req.ip; // get user ip from callback URL
							handleSmartIdData(row.transaction_id, body);
						}
						if (err) {
							console.error('getUserData', err, body);
							return res.sendFile(__dirname+'/failed.html');
						}
						else {
							return res.sendFile(__dirname+'/done.html');
						}
					});
				}
			});
		}
	);
}

function getCountryByIp(ip){
	let countryInfo = countryLookup.get(ip);
	if (!countryInfo || !countryInfo.country){
		console.log('failed to determine country of IP '+ip);
		return 'UNKNOWN';
	}
	let ipCountry = countryInfo.country.iso_code;
	console.log('country by IP: '+ipCountry);
	if (!ipCountry){
		console.log('no country of IP '+ip);
		return 'UNKNOWN';
	}
	return ipCountry;
}

function handleJumioData(transaction_id, body){
	let data = body.transaction ? jumioApi.convertRestResponseToCallbackFormat(body) : body;
	if (typeof data.identityVerification === 'string') // contrary to docs, it is a string, not an object
		data.identityVerification = JSON.parse(data.identityVerification);
	let scan_result = (data.verificationStatus === 'APPROVED_VERIFIED') ? 1 : 0;
	let error = scan_result ? '' : data.verificationStatus;
	let bHasLatNames = (scan_result && data.idFirstName && data.idLastName && data.idFirstName !== 'N/A' && data.idLastName !== 'N/A');
	if (bHasLatNames && data.idCountry === 'RUS' && data.idType === 'ID_CARD') // Russian internal passport
		bHasLatNames = false;
	if (scan_result && !bHasLatNames){
		scan_result = 0;
		error = "couldn't extract your name. Please [try again](command:again) and provide a document with your name printed in Latin characters.";
	}
	if (scan_result && !data.identityVerification){
		console.error("no identityVerification in tx "+transaction_id);
		return;
	}
	if (scan_result && (!data.identityVerification.validity || data.identityVerification.similarity !== 'MATCH')){ // selfie check and selfie match
		scan_result = 0;
		error = data.identityVerification.reason || data.identityVerification.similarity;
	}
	handleAttestation(transaction_id, body, data, scan_result, error);
}

function handleSmartIdData(transaction_id, body){
	let data = body.status ? smartidApi.convertRestResponseToCallbackFormat(body) : body;
	let scan_result = (data.verificationStatus === 'APPROVED_VERIFIED') ? 1 : 0;
	let error = body.error_description ? body.error_description : '';
	if (!data.idFirstName || !data.idLastName || !data.idDob || !data.idCountry) {
		scan_result = 0;
		error = 'some required data missing';
	}
	handleAttestation(transaction_id, body, data, scan_result, error);
}

function handleAttestation(transaction_id, body, data, scan_result, error) {
	let device = require('ocore/device.js');

	mutex.lock(['tx-'+transaction_id], unlock => {
		db.query(
			"UPDATE transactions SET scan_result=?, result_date="+db.getNow()+", extracted_data=? \n\
			WHERE transaction_id=? AND scan_result IS NULL", 
			[scan_result, JSON.stringify(body), transaction_id]);
		db.query(
			"SELECT user_address, device_address, service_provider, received_amount, payment_unit, voucher \n\
			FROM transactions CROSS JOIN receiving_addresses USING(receiving_address) WHERE transaction_id=?", 
			[transaction_id],
			rows => {
				let row = rows[0];
				if (scan_result === 0){
					device.sendMessageToDevice(row.device_address, 'text', "Verification failed: "+error+"\n\nTry [again](command:again)?");
					return unlock();
				}
				let bNonUS = (data.idCountry !== 'USA' && data.idCountry !== 'US');
				if (bNonUS){
					let ipCountry = getCountryByIp(data.clientIp);
					if (ipCountry === 'US' || ipCountry === 'UNKNOWN')
						bNonUS = false;
				}
				db.query("INSERT "+db.getIgnore()+" INTO attestation_units (transaction_id, attestation_type) VALUES (?, 'real name')", [transaction_id], async () => {
					let [attestation, src_profile] = realNameAttestation.getAttestationPayloadAndSrcProfile(row.user_address, data, row.service_provider);
					realNameAttestation.postAndWriteAttestation(transaction_id, 'real name', realNameAttestation.assocAttestorAddresses[row.service_provider === 'smartid' ? 'smartid' : 'jumio'], attestation, src_profile);

					setTimeout(() => {
						if (bNonUS){
							device.sendMessageToDevice(row.device_address, 'text', texts.attestNonUS());
							setTimeout(() => {
								if (assocAskedForDonation[row.device_address])
									return;
								device.sendMessageToDevice(row.device_address, 'text', texts.pleaseDonate());
								assocAskedForDonation[row.device_address] = Date.now();
							}, 6000);
						}
						else
							device.sendMessageToDevice(row.device_address, 'text', texts.pleaseDonate());
					}, 2000);
					if (conf.bRefundAttestationFee || conf.contractRewardInUSD){
						let rewardInBytes = conf.bRefundAttestationFee ? row.received_amount : 0;
						let contractRewardInBytes = conversion.getPriceInBytes(conf.contractRewardInUSD);
						db.query(
							"INSERT "+db.getIgnore()+" INTO reward_units (transaction_id, device_address, user_address, user_id, reward, contract_reward) VALUES (?, ?,?,?, ?,?)", 
							[transaction_id, row.device_address, row.user_address, attestation.profile.user_id, rewardInBytes, contractRewardInBytes], 
							async (res) => {
								console.log("reward_units insertId: "+res.insertId+", affectedRows: "+res.affectedRows);
								if (!res.affectedRows){
									console.log("duplicate user_address or user_id or device address: "+row.user_address+", "+attestation.profile.user_id+", "+row.device_address);
									return unlock();
								}
								let [contract_address, vesting_ts] = await contract.createContract(row.user_address, row.device_address);
								let message = '';
								if (rewardInBytes > 0) {
									message += `You were attested for the first time and your attestation fee (${(rewardInBytes/1e9).toLocaleString([], {maximumFractionDigits: 9})} GB) will be refunded from Obyte distribution fund.`;
								}
								else {
									message += `You were attested for the first time.`;
								}
								message += ` You will ${rewardInBytes ? 'also ' : ''}receive a reward of $${conf.contractRewardInUSD.toLocaleString([], {minimumFractionDigits: 2})} (${(contractRewardInBytes/1e9).toLocaleString([], {maximumFractionDigits: 9})} GB) that will be locked on a smart contract for ${conf.contractTerm} year and can be spent only after ${new Date(vesting_ts).toDateString()}.`;

								device.sendMessageToDevice(row.device_address, 'text', message);
								reward.sendAndWriteReward('attestation', transaction_id);

								if (conf.referralRewardInUSD || conf.contractReferralRewardInUSD){
									let referralRewardInBytes = conversion.getPriceInBytes(conf.referralRewardInUSD);
									let contractReferralRewardInBytes = conversion.getPriceInBytes(conf.contractReferralRewardInUSD);
									let voucherInfo = null;
									if (row.voucher) {
										voucherInfo = await voucher.getInfo(row.voucher);
									}
									if (row.payment_unit) {
										reward.findReferrer(row.payment_unit, async (referring_user_id, referring_user_address, referring_user_device_address) => {
											if (!referring_user_address){
												console.log("no referring user for "+row.user_address);
												return unlock();
											}
											let [referrer_contract_address, referrer_vesting_date_ts] = 
												await contract.getReferrerContract(referring_user_address, referring_user_device_address);
											db.query(
												"INSERT "+db.getIgnore()+" INTO referral_reward_units \n\
												(transaction_id, user_address, user_id, new_user_address, new_user_id, reward, contract_reward) VALUES (?, ?,?, ?,?, ?,?)", 
												[transaction_id, 
												referring_user_address, referring_user_id, 
												row.user_address, attestation.profile.user_id, 
												referralRewardInBytes, contractReferralRewardInBytes], 
												(res) => {
													console.log("referral_reward_units insertId: "+res.insertId+", affectedRows: "+res.affectedRows);
													if (!res.affectedRows){
														notifications.notifyAdmin("duplicate referral reward", "referral reward for new user "+row.user_address+" "+attestation.profile.user_id+" already written");
														return unlock();
													}
													let reward_text = referralRewardInBytes
														? "and you will receive a reward of $"+conf.referralRewardInUSD.toLocaleString([], {minimumFractionDigits: 2})+" ("+(referralRewardInBytes/1e9).toLocaleString([], {maximumFractionDigits: 9})+" GB) from Obyte distribution fund"
														: "and you will receive a reward of $"+conf.contractReferralRewardInUSD.toLocaleString([], {minimumFractionDigits: 2})+" ("+(contractReferralRewardInBytes/1e9).toLocaleString([], {maximumFractionDigits: 9})+" GB) from Obyte distribution fund. The reward will be paid to a smart contract which can be spent after "+new Date(referrer_vesting_date_ts).toDateString();
													device.sendMessageToDevice(referring_user_device_address, 'text', texts.referredNewUser(reward_text));
													reward.sendAndWriteReward('referral', transaction_id);
													unlock();
												}
											);
										});
									}
									else if (voucherInfo) {
										db.query(
											`SELECT payload FROM messages
											JOIN attestations USING (unit, message_index)
											WHERE address=? AND attestor_address IN (?)
											ORDER BY attestations.rowid DESC LIMIT 1`,
											[voucherInfo.user_address, [realNameAttestation.assocAttestorAddresses['jumio'], realNameAttestation.assocAttestorAddresses['smartid']]],
											function(rows) {
												if (!rows.length) {
													throw Error(`no attestation for voucher user_address ${voucherInfo.user_address}`);
												}
												let payload = JSON.parse(rows[0].payload);
												let user_id = payload.profile.user_id;
												if (!user_id)
													throw Error(`no user_id for user_address ${voucherInfo.user_address}`);
												
												let amountUSD = conf.referralRewardInUSD+conf.contractReferralRewardInUSD;
												if (row.service_provider === 'smartid') {
													amountUSD += conf.priceInUSDforSmartID;
												}
												else {
													amountUSD += conf.priceInUSD;
												}
												let amount = conversion.getPriceInBytes(amountUSD);

												db.query(
													`INSERT ${db.getIgnore()} INTO referral_reward_units
													(transaction_id, user_address, user_id, new_user_address, new_user_id, reward)
													VALUES (?, ?, ?, ?, ?, ?)`,
													[transaction_id, voucherInfo.user_address, user_id, row.user_address, attestation.profile.user_id, amount],
													(res) => {
														console.log("referral_reward_units insertId: "+res.insertId+", affectedRows: "+res.affectedRows);
														device.sendMessageToDevice(voucherInfo.device_address, 'text', `A user just verified his identity using your smart voucher ${voucherInfo.voucher} and you will receive a reward of $${amountUSD.toLocaleString([], {minimumFractionDigits: 2})} (${(amount/1e9).toLocaleString([], {maximumFractionDigits: 9})} GB). Thank you for bringing in a new obyter, the value of the ecosystem grows with each new user!`);
														reward.sendAndWriteReward('referral', transaction_id);
														unlock();
													}
												);
											}
										);
									}
								}
							}
						);
					}
				});
			}
		);
	});
}


async function getPriceInUSD(user_address, service_provider){
	let objDiscount = await discounts.getDiscount(user_address);
	let discountPrice = conf.priceInUSD;
	if (service_provider === 'smartid') {
		discountPrice = conf.priceInUSDforSmartID;
	}
	discountPrice *= 1-objDiscount.discount/100;
	objDiscount.priceInUSDnoRound = discountPrice;
	discountPrice = Math.round(discountPrice*100)/100;
	objDiscount.priceInUSD = discountPrice;
	return objDiscount;
}

function respond(from_address, text, response){
	let device = require('ocore/device.js');
	let lc_text = text.toLowerCase();
	readUserInfo(from_address, async (userInfo) => {
		
		function checkUserAddress(onDone){
			if (validationUtils.isValidAddress(text)){
				userInfo.user_address = text;
				response += texts.goingToAttest(userInfo.user_address) + "\n\n";
				db.query("UPDATE users SET user_address=? WHERE device_address=?", [userInfo.user_address, from_address], () => {
					onDone()
				});
				return;
			}
			if (userInfo.user_address)
				return onDone();
			onDone(texts.insertMyAddress());
		}

		function getAttestation(device_address, user_address) {
			return new Promise(resolve => {
				db.query(
					`SELECT scan_result, attestation_date, transaction_id, extracted_data, user_address
					FROM transactions JOIN receiving_addresses USING(receiving_address) JOIN attestation_units USING(transaction_id)
					WHERE (receiving_addresses.device_address=? OR receiving_addresses.user_address=?) ORDER BY transaction_id DESC LIMIT 1`, [device_address, user_address], resolve);
			})
		}
		
		function hasSuccessfulOrOngoingAttestation(device_address, user_address) {
			return new Promise(resolve => {
				db.query(
					`SELECT 1
					FROM transactions JOIN receiving_addresses USING(receiving_address)
					WHERE (receiving_addresses.device_address=? OR receiving_addresses.user_address=?) AND (scan_result=1 OR scan_result IS NULL) LIMIT 1`, [device_address, user_address], function(rows) {
						resolve(rows.length > 0)
					});
			})
		}
		
		function hasSuccessfulAttestation(device_address, user_address) {
			return new Promise(resolve => {
				db.query(
					`SELECT 1
					FROM transactions JOIN receiving_addresses USING(receiving_address)
					WHERE receiving_addresses.device_address=? AND receiving_addresses.user_address=? AND scan_result=1 LIMIT 1`, [device_address, user_address], function(rows) {
						resolve(rows.length > 0)
					});
			})
		}
		
		if (lc_text === 'help')
			return device.sendMessageToDevice(from_address, 'text', texts.vouchersHelp());
		if (lc_text === 'new voucher') {
			if (!userInfo.user_address)
				return device.sendMessageToDevice(from_address, 'text', texts.insertMyAddress());
			let bAttested = await hasSuccessfulAttestation(from_address, userInfo.user_address);
			if (!bAttested)
				return device.sendMessageToDevice(from_address, 'text', `Only attested users can issue vouchers`);
			let [voucher_code] = await voucher.issueNew(userInfo.user_address, from_address);
			device.sendMessageToDevice(from_address, 'text', `New smart voucher: ${voucher_code}\n\n` + texts.depositVoucher(voucher_code) + '\n\n' + texts.vouchersHelp());
			return;
		}
		if (lc_text === 'vouchers') {
			let vouchers = await voucher.getAllUserVouchers(userInfo.user_address);
			if (!vouchers.length)
				return device.sendMessageToDevice(from_address, 'text', texts.noVouchers());
			return device.sendMessageToDevice(from_address, 'text', texts.listVouchers(userInfo.user_address, vouchers));
		}
		if (lc_text.startsWith('deposit')) {
			let tokens = text.split(" ");
			if (tokens.length == 1)
				return device.sendMessageToDevice(from_address, 'text', texts.depositVoucher());
			let voucher_code = tokens[1];
			let voucherInfo = await voucher.getInfo(voucher_code);
			if (!voucherInfo)
				return device.sendMessageToDevice(from_address, 'text', `invalid voucher: ${voucher_code}`);
			if (tokens.length == 3) {
				let usd_amount = parseFloat(tokens[2]);
				let amount = conversion.getPriceInBytes(usd_amount);
				if (amount && isFinite(amount))
					return device.sendMessageToDevice(from_address, 'text', texts.payToVoucher(voucherInfo.receiving_address, voucher_code, amount, userInfo.user_address));
			}
			return device.sendMessageToDevice(from_address, 'text', texts.depositVoucher(voucher_code));
		}
		if (lc_text.startsWith('limit')) { // voucher
			let tokens = text.split(" ");
			if (tokens.length != 3)
				return device.sendMessageToDevice(from_address, 'text', texts.limitVoucher());
			let voucher_code = tokens[1];
			let limit = tokens[2]|0;
			let voucherInfo = await voucher.getInfo(voucher_code);
			if (!voucherInfo)
				return device.sendMessageToDevice(from_address, 'text', `invalid voucher: ${voucher_code}`);
			if (limit < 1)
				return device.sendMessageToDevice(from_address, 'text', `invalid limit: ${limit}, should be > 0`);
			if (from_address != voucherInfo.device_address)
				return device.sendMessageToDevice(from_address, 'text', `its not your smart voucher!`);
			await voucher.setLimit(voucherInfo.voucher, limit);
			return device.sendMessageToDevice(from_address, 'text', `new limit ${limit} for smart voucher ${voucher_code}`);
		}
		if (lc_text.startsWith('withdraw')) {
			let tokens = text.split(" ");
			if (tokens.length < 2)
				return device.sendMessageToDevice(from_address, 'text', `format: withdraw VOUCHER amount`);
			let voucher_code = tokens[1];
			mutex.lock(['voucher-'+voucher_code], async (unlock) => {
				let voucherInfo = await voucher.getInfo(voucher_code);
				if (!voucherInfo) {
					unlock();
					return device.sendMessageToDevice(from_address, 'text', `invalid voucher: ${voucher_code}`);
				}
				if (from_address != voucherInfo.device_address) {
					unlock();
					return device.sendMessageToDevice(from_address, 'text', `its not your smart voucher!`);
				}
				if (tokens.length == 3) {
					let gb_amount = tokens[2];
					let amount = Math.round(gb_amount * 1e9);
					if (!isFinite(amount) || amount <= 0){
						unlock();
						return device.sendMessageToDevice(from_address, 'text', `Withdraw amount must be positive`);
					}
					if (amount > voucherInfo.amount) {
						unlock();
						return device.sendMessageToDevice(from_address, 'text', `not enough funds on smart voucher ${voucher_code} for withdrawal (tried to claim ${amount} bytes, but smart voucher only has ${voucherInfo.amount} bytes`);
					}
					let [err, bytes, contract_bytes] = await voucher.withdraw(voucherInfo, amount);
					if (!err)
						device.sendMessageToDevice(from_address, 'text', texts.withdrawComplete(bytes, contract_bytes, await voucher.getInfo(voucher_code)));
					else
						device.sendMessageToDevice(from_address, 'text', err);
					return unlock();
				}
				unlock();
				device.sendMessageToDevice(from_address, 'text', texts.withdrawVoucher(voucherInfo));
			});
			return;
		}
		if (text.length == 13) { // voucher
			if (!userInfo.user_address)
				return device.sendMessageToDevice(from_address, 'text', texts.insertMyAddress());
			let has_attestation = await hasSuccessfulOrOngoingAttestation(from_address, userInfo.user_address);
			if (!has_attestation) { // never been attested on this device or user_address
				mutex.lock(['voucher-'+text], async (unlock) => {
					let voucherInfo = await voucher.getInfo(text);
					if (!voucherInfo) {
						unlock();
						return device.sendMessageToDevice(from_address, 'text', `invalid voucher: ${text}`);
					}
					unlock();
					device.sendMessageToDevice(from_address, 'text', `Using smart voucher ${text}. Now we need to confirm that you are the owner of address ${userInfo.user_address}. Please sign the following message: [s](sign-message-request:${texts.signMessage(userInfo.user_address, text)})`);
				});
			} else 
				return device.sendMessageToDevice(from_address, 'text', texts.alreadyHasAttestation());
			return;
		}
		let arrSignedMessageMatches = text.match(/\(signed-message:(.+?)\)/);
		if (arrSignedMessageMatches){ // signed message received, continue with voucher
			if (!userInfo.user_address)
				return device.sendMessageToDevice(from_address, 'text', texts.insertMyAddress());
			let signedMessageBase64 = arrSignedMessageMatches[1];
			var validation = require('ocore/validation.js');
			var signedMessageJson = Buffer(signedMessageBase64, 'base64').toString('utf8');
			try{
				var objSignedMessage = JSON.parse(signedMessageJson);
			}
			catch(e){
				return null;
			}
			validation.validateSignedMessage(objSignedMessage, err => {
				if (err)
					return device.sendMessageToDevice(from_address, 'text', `wrong signature`);
				if (objSignedMessage.authors[0].address !== userInfo.user_address)
					return device.sendMessageToDevice(from_address, 'text', `You signed the message with a wrong address: ${objSignedMessage.authors[0].address}, expected: ${userInfo.user_address}`);
				let voucher_code_matches = objSignedMessage.signed_message.match(/.+\s([A-Z2-7]{13})\b/);
				if (!voucher_code_matches)
					return device.sendMessageToDevice(from_address, 'text', `wrong message text signed`);
				let voucher_code = voucher_code_matches[1];
				if (objSignedMessage.signed_message != texts.signMessage(userInfo.user_address, voucher_code))
					return device.sendMessageToDevice(from_address, 'text', `wrong message text signed`);
				readOrAssignReceivingAddress(from_address, userInfo.user_address, userInfo.service_provider, async (receiving_address) => {
					let has_attestation = await hasSuccessfulOrOngoingAttestation(from_address, userInfo.user_address);
					if (!has_attestation) { // never been attested on this device or user_address
						text = voucher_code;
						mutex.lock(['voucher-'+text], async (unlock) => {
							let voucherInfo = await voucher.getInfo(text);
							if (!voucherInfo) {
								unlock();
								return device.sendMessageToDevice(from_address, 'text', `invalid voucher: ${text}`);
							}
							let objDiscountedPriceInUSD = await getPriceInUSD(userInfo.user_address, userInfo.service_provider);
							let price = conversion.getPriceInBytes(objDiscountedPriceInUSD.priceInUSDnoRound);
							if (voucherInfo.amount < price) {
								unlock();
								device.sendMessageToDevice(voucherInfo.device_address, 'text', `A user tried to attest using your smart voucher ${text}, but it does not have enough funds. ` + texts.depositVoucher(text));
								return device.sendMessageToDevice(from_address, 'text', `Smart voucher ${text} does not have enough funds, we notified the owner of this voucher.`);
							}
							// voucher limit
							db.query(`SELECT COUNT(1) AS count FROM transactions
								JOIN receiving_addresses USING(receiving_address)
								WHERE voucher=? AND device_address=?`,
								[voucherInfo.voucher, from_address],
								function(rows){
									var count = rows[0].count;
									if (rows[0].count >= voucherInfo.usage_limit) {
										unlock();
										return device.sendMessageToDevice(from_address, 'text', `You reached the limit of uses for voucher ${text}`);
									}

									db.takeConnectionFromPool(async (connection) => {
										await connection.query(`BEGIN TRANSACTION`);
										let res = await connection.query(`INSERT INTO transactions (receiving_address, voucher, price, received_amount, signed_message) VALUES (?, ?, 0, 0, ?)`, [receiving_address, voucherInfo.voucher, signedMessageJson]);
										let transaction_id = res.insertId;
										if (!transaction_id)
											throw Error("no insertId in voucher transaction");
										await connection.query(`INSERT INTO voucher_transactions (voucher, transaction_id, amount) VALUES (?, last_insert_rowid(), ?)`,
											[voucherInfo.voucher, -price]);
										await connection.query(`UPDATE vouchers SET amount=amount-? WHERE voucher=?`, [price, voucherInfo.voucher]);
										await connection.query(`COMMIT`);
										connection.release();
										unlock();

										if (userInfo.service_provider === 'smartid') {
											serviceHelper.initSmartIdLogin(transaction_id, from_address, userInfo.user_address);
										}
										else {
											serviceHelper.initAndWriteJumioScan(transaction_id, from_address, userInfo.user_address);
										}
										device.sendMessageToDevice(voucherInfo.device_address, 'text', `A user has just used your smart voucher ${text} to pay for attestation, new voucher balance ${((voucherInfo.amount-price)/1e9).toLocaleString([], {maximumFractionDigits: 9})} GB`);
									});
								}
							);
						});
					} else 
						return device.sendMessageToDevice(from_address, 'text', texts.alreadyHasAttestation());
				});
			});
			return;
		}
		
		checkUserAddress(user_address_response => {
			if (user_address_response)
				return device.sendMessageToDevice(from_address, 'text', response + user_address_response);
			
			if (text === 'jumio' || text === 'smartid'){
				userInfo.service_provider = text;
				db.query("UPDATE users SET service_provider=? WHERE device_address=? AND user_address=?;", 
					[userInfo.service_provider, from_address, userInfo.user_address]);
				
				if (userInfo.service_provider === "smartid")
					response += texts.providerSmartID() + "\n\n";
				else
					response += texts.providerJumio() + "\n\n";
			}
			if (!userInfo.service_provider)
				return device.sendMessageToDevice(from_address, 'text', response + texts.welcomeProviders());
			
			readOrAssignReceivingAddress(from_address, userInfo.user_address, userInfo.service_provider, async (receiving_address) => {
				let objDiscountedPriceInUSD = await getPriceInUSD(userInfo.user_address, userInfo.service_provider);
				let price = conversion.getPriceInBytes(objDiscountedPriceInUSD.priceInUSDnoRound);
				updatePrice(receiving_address, price);

				if (text === 'again') {
					let has_attestation = await hasSuccessfulOrOngoingAttestation(from_address, userInfo.user_address);
					return device.sendMessageToDevice(from_address, 'text', response + texts.pleasePayOrProvider(receiving_address, price, userInfo.user_address, userInfo.service_provider, objDiscountedPriceInUSD, has_attestation));
				}
				let rows = await getAttestation(from_address, userInfo.user_address);
				if (rows.length === 0)
					return device.sendMessageToDevice(from_address, 'text', response + texts.pleasePayOrProvider(receiving_address, price, userInfo.user_address, userInfo.service_provider, objDiscountedPriceInUSD));
				let row = rows[0];
				let scan_result = row.scan_result;
				if (scan_result === null)
					return device.sendMessageToDevice(from_address, 'text', response + texts.underWay());
				if (scan_result === 0)
					return device.sendMessageToDevice(from_address, 'text', response + texts.previousAttestationFailed());
				// scan_result === 1
				if (text === 'attest non-US'){
					db.query(
						"SELECT attestation_unit FROM attestation_units WHERE transaction_id=? AND attestation_type='nonus'", 
						[row.transaction_id],
						nonus_rows => {
							if (nonus_rows.length > 0){ // already exists
								let attestation_unit = nonus_rows[0].attestation_unit;
								return device.sendMessageToDevice(from_address, 'text', 
									response + ( attestation_unit ? texts.alreadyAttestedInUnit(attestation_unit) : texts.underWay() ) );
							}
							let data = JSON.parse(row.extracted_data);
							let cb_data;
							if (userInfo.service_provider === 'smartid') {
								cb_data = data.status ? smartidApi.convertRestResponseToCallbackFormat(data) : data;
							}
							else {
								cb_data = data.transaction ? jumioApi.convertRestResponseToCallbackFormat(data) : data;
							}
							if (cb_data.idCountry === 'USA' || cb_data.idCountry === 'US')
								return device.sendMessageToDevice(from_address, 'text', response + "You are an US citizen, can't attest non-US");
							db.query("INSERT INTO attestation_units (transaction_id, attestation_type) VALUES (?,'nonus')", [row.transaction_id], ()=>{
								let nonus_attestation = realNameAttestation.getNonUSAttestationPayload(row.user_address);
								realNameAttestation.postAndWriteAttestation(row.transaction_id, 'nonus', realNameAttestation.assocAttestorAddresses['nonus'], nonus_attestation);
								setTimeout(() => {
									if (assocAskedForDonation[from_address])
										return;
									device.sendMessageToDevice(from_address, 'text', texts.pleaseDonate());
									assocAskedForDonation[from_address] = Date.now();
								}, 2000);
							});
						}
					);
				}
				else if (text === 'donate yes'){
					db.query("UPDATE reward_units SET donated=1 WHERE (device_address=? OR user_address=?)", [from_address, row.user_address]);
					device.sendMessageToDevice(from_address, 'text', "Thanks for your donation!");
				}
				else if (text === 'donate no'){
					db.query("UPDATE reward_units SET donated=0 WHERE (device_address=? OR user_address=?) AND donated IS NULL", [from_address, row.user_address]);
					device.sendMessageToDevice(from_address, 'text', "Thanks for your choice.");
				}
				else
					device.sendMessageToDevice(from_address, 'text', response + texts.alreadyAttested(row.attestation_date));
			});
		});
	});
}

eventBus.on('paired', from_address => {
	respond(from_address, '', texts.greeting() + "\n\n");
});

eventBus.once('headless_and_rates_ready', () => {
	const headlessWallet = require('headless-obyte');
	if (conf.bRunWitness){
		require('obyte-witness');
		eventBus.emit('headless_wallet_ready');
	}
	else
		headlessWallet.setupChatEventHandlers();
	eventBus.on('text', (from_address, text) => {
		respond(from_address, text.trim(), '');
	});
	
	eventBus.on('new_my_transactions', arrUnits => {
		let device = require('ocore/device.js');
		console.log("new_my_transactions units:", arrUnits);
		db.query(
			`SELECT amount, asset, device_address, receiving_address, service_provider, user_address, unit, price, ${db.getUnixTimestamp('last_price_date')} AS price_ts, NULL AS from_distribution
			FROM outputs
			CROSS JOIN receiving_addresses ON outputs.address=receiving_addresses.receiving_address
			WHERE unit IN(?) AND NOT EXISTS (SELECT 1 FROM unit_authors CROSS JOIN my_addresses USING(address) WHERE unit_authors.unit=outputs.unit)
			UNION -- vouchers deposit / reward
			SELECT outputs.amount, asset, device_address, receiving_address, "" AS service_provider, user_address, unit, 0 AS price, CURRENT_TIMESTAMP AS price_ts,
				(SELECT 1 FROM inputs WHERE address=? AND unit=outputs.unit LIMIT 1) AS from_distribution
			FROM outputs
			CROSS JOIN vouchers ON outputs.address=vouchers.receiving_address
			WHERE unit IN(?) AND NOT EXISTS (SELECT 1 FROM unit_authors CROSS JOIN vouchers ON vouchers.receiving_address=unit_authors.address WHERE unit_authors.unit=outputs.unit)`,
			[arrUnits, reward.distribution_address, arrUnits],
			rows => {
				console.log("new_my_transactions rows: ", rows);
				rows.forEach(row => {
			
					async function checkPayment(onDone){
						if (row.asset !== null)
							return onDone("Received payment in wrong asset", delay);
						if (row.price > 0) {// not voucher
							let delay = Math.round(Date.now()/1000 - row.price_ts);
							let bLate = (delay > PRICE_TIMEOUT);
							let objDiscountedPriceInUSD = await getPriceInUSD(row.user_address, row.service_provider);
							let current_price = conversion.getPriceInBytes(objDiscountedPriceInUSD.priceInUSDnoRound);
							let expected_amount = bLate ? current_price : row.price;
							if (row.amount < expected_amount){
								updatePrice(row.device_address, current_price);
								let text = "Received "+(row.amount/1e9)+" GB from you";
								text += bLate 
									? ". Your payment is too late and less than the current price. " 
									: ", which is less than the expected "+(row.price/1e9)+" GB. ";
								return onDone(text + texts.pleasePay(row.receiving_address, current_price, row.user_address, objDiscountedPriceInUSD), delay);
							}
						}
						db.query("SELECT address FROM unit_authors WHERE unit=?", [row.unit], author_rows => {
							if (author_rows.length !== 1){
								resetUserAddress();
								return onDone("Received a payment but looks like it was not sent from a single-address wallet. "+texts.switchToSingleAddress());
							}
							if (row.price > 0 && author_rows[0].address !== row.user_address){ // only for non-vouchers
								resetUserAddress();
								return onDone("Received a payment but it was not sent from the expected address "+row.user_address+". "+texts.switchToSingleAddress());
							}
							onDone();
						});
					}
		
					function resetUserAddress(){
						db.query("UPDATE users SET user_address=NULL WHERE device_address=?", [row.device_address]);
					}
		
					checkPayment((error, delay) => {
						if (error){
							return db.query(
								"INSERT "+db.getIgnore()+" INTO rejected_payments (receiving_address, price, received_amount, delay, payment_unit, error) \n\
								VALUES (?,?, ?,?, ?,?)", 
								[row.receiving_address, row.price, row.amount, delay, row.unit, error],
								() => {
									device.sendMessageToDevice(row.device_address, 'text', error);
								}
							);
						}

						if (row.price > 0)
							db.query(
								"INSERT INTO transactions (receiving_address, price, received_amount, payment_unit) VALUES (?,?, ?,?)", 
								[row.receiving_address, row.price, row.amount, row.unit]
							);
						else {
							db.query(
								`INSERT INTO voucher_transactions (voucher, amount, unit)
								SELECT voucher, ?, ? FROM vouchers WHERE receiving_address=?`, 
								[row.amount, row.unit, row.receiving_address]
							);
							if (row.from_distribution) {
								db.query(`UPDATE vouchers SET amount=amount+? WHERE receiving_address=?`,
									[row.amount, row.receiving_address]);
								return;
							}
						}
						device.sendMessageToDevice(row.device_address, 'text', "Received your payment of "+(row.amount/1e9)+" GB, waiting for confirmation. It should take 5-15 minutes.");
					});
				});
			}
		);
	});
	
	eventBus.on('my_transactions_became_stable', arrUnits => {
		let device = require('ocore/device.js');
		db.query( // transactions
			`SELECT transaction_id, device_address, user_address, service_provider
			FROM transactions JOIN receiving_addresses USING(receiving_address)
			WHERE payment_unit IN(?)`,
			[arrUnits],
			rows => {
				rows.forEach(row => {
					db.query("UPDATE transactions SET confirmation_date="+db.getNow()+", is_confirmed=1 WHERE transaction_id=?", [row.transaction_id]);
					device.sendMessageToDevice(row.device_address, 'text', "Your payment is confirmed, redirecting to attestation service provider...");
					if (row.service_provider === 'smartid') {
						serviceHelper.initSmartIdLogin(row.transaction_id, row.device_address, row.user_address);
					}
					else {
						serviceHelper.initAndWriteJumioScan(row.transaction_id, row.device_address, row.user_address);
					}
				});
			}
		);
		db.query( // deposit vouchers
			`SELECT voucher, vouchers.amount AS old_amount, device_address, outputs.amount
			FROM vouchers
			JOIN outputs ON outputs.address=vouchers.receiving_address
			WHERE outputs.unit IN (?) AND outputs.asset IS NULL AND NOT EXISTS (SELECT 1 FROM unit_authors CROSS JOIN my_addresses USING(address) WHERE unit_authors.unit=outputs.unit)`,
			[arrUnits],
			rows => {
				rows.forEach(row => {
					db.query(`UPDATE vouchers SET amount=amount+?, amount_deposited=amount_deposited+? WHERE voucher=?`, [row.amount, row.amount, row.voucher]);
					device.sendMessageToDevice(row.device_address, 'text', texts.voucherDeposited(row.voucher, row.old_amount+row.amount));
				});
			}
		);
	});
});


function pollAndHandleJumioScanData(){
	serviceHelper.pollJumioScanData(handleJumioData);
}

eventBus.once('headless_wallet_ready', () => {
	let error = '';
	let arrTableNames = ['users', 'receiving_addresses', 'transactions', 'attestation_units', 'rejected_payments'];
	db.query("SELECT name FROM sqlite_master WHERE type='table' AND name IN (?)", [arrTableNames], async (rows) => {
		if (rows.length !== arrTableNames.length)
			error += texts.errorInitSql();

		if (!conf.admin_email || !conf.from_email) 
			error += texts.errorEmail();
		
		if (!conf.salt)
			error += "Please set salt in conf for hashing user ids";

		if (error)
			throw new Error(error);

		await db_migrations();
		await db_migrations2();
		
		let headlessWallet = require('headless-obyte');
		headlessWallet.issueOrSelectAddressByIndex(0, 0, address1 => {
			console.log('== jumio attestation address: '+address1);
			realNameAttestation.assocAttestorAddresses['jumio'] = address1;
			headlessWallet.issueOrSelectAddressByIndex(0, 1, address2 => {
				console.log('== non-US attestation address: '+address2);
				realNameAttestation.assocAttestorAddresses['nonus'] = address2;
				headlessWallet.issueOrSelectAddressByIndex(0, 2, address3 => {
					console.log('== distribution address: '+address3);
					reward.distribution_address = address3;
					headlessWallet.issueOrSelectAddressByIndex(0, 3, address4 => {
						console.log('== smartid attestation address: '+address4);
						realNameAttestation.assocAttestorAddresses['smartid'] = address4;

						server.listen(conf.webPort);
						
						setInterval(serviceHelper.retryInitScans, 60*1000);
						setInterval(realNameAttestation.retryPostingAttestations, 10*1000);
						setInterval(reward.retrySendingRewards, 120*1000);
						setInterval(pollAndHandleJumioScanData, 300*1000);
						setInterval(moveFundsToAttestorAddresses, 60*1000);
						setInterval(reward.sendDonations, 7*24*3600*1000);
						setInterval(serviceHelper.cleanExtractedData, 24*3600*1000);
						
						const consolidation = require('headless-obyte/consolidation.js');
						consolidation.scheduleConsolidation(realNameAttestation.assocAttestorAddresses['jumio'], headlessWallet.signer, 100, 3600*1000);
						consolidation.scheduleConsolidation(realNameAttestation.assocAttestorAddresses['smartid'], headlessWallet.signer, 100, 3600*1000);
						consolidation.scheduleConsolidation(realNameAttestation.assocAttestorAddresses['nonus'], headlessWallet.signer, 100, 3600*1000);
					});
				});
			});
		});
	});
});

process.on('unhandledRejection', up => { throw up; });
