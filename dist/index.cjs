'use strict';

var node_child_process = require('node:child_process');
var ethers = require('ethers');
var node_fs = require('node:fs');
var promises = require('node:fs/promises');
var node_path = require('node:path');
var node_os = require('node:os');
var node_util = require('node:util');
var node_console = require('node:console');
var EventEmitter = require('node:events');

function error_with(message, params, cause) {
	let error;
	if (cause) {
		error = new Error(message, {cause});
		if (!error.cause) error.cause = cause;
	} else {
		error = new Error(message);
	}
	return Object.assign(error, params);
}

function is_address(s) {
	return typeof s === 'string' && /^0x[0-9a-f]{40}$/i.test(s);
}

function to_address(x) {
	if (x) {
		if (is_address(x)) return x;
		if (is_address(x.target)) return x.target;
		if (is_address(x.address)) return x.address;
		if (is_address(x.contractAddress)) return x.contractAddress;
	}
}

// https://toml.io/en/v1.0.0

function encode(obj) {
	let lines = [];
	write(lines, obj, []);
	return lines.join('\n');
}

function write(lines, obj, path) {
	let after = [];
	for (let [k, v] of Object.entries(obj)) {
		if (v === null) continue;
		if (is_basic(v)) {
			lines.push(`${encode_key(k)} = ${format_value(v)}`);
		} else if (Array.isArray(v)) {
			if (v.every(is_basic)) {
				lines.push(`${encode_key(k)} = [${v.map(format_value)}]`);
			} else {
				after.push([k, v]);
			}
		} else if (v?.constructor === Object) {
			after.push([k, v]);
		} else {
			throw error_with(`invalid type: "${k}"`, undefined, {key: k, value: v})
		}
	}
	for (let [k, v] of after) {
		path.push(encode_key(k));
		if (Array.isArray(v)) {
			let header = `[[${path.join('.')}]]`;
			for (let x of v) {
				lines.push(header);
				write(lines, x, path);
			}
		} else {
			lines.push(`[${path.join('.')}]`);
			write(lines, v, path);
		}
		path.pop();
	}
}

function format_value(x) {
	if (typeof x === 'number' && Number.isInteger(x) && x > 9223372036854775000e0) {
		return '9223372036854775000'; // next smallest javascript integer below 2^63-1
	} 
	return JSON.stringify(x);
}

function encode_key(x) {
	return /^[a-z_][a-z0-9_]*$/i.test(x) ? x : JSON.stringify(x);
}

function is_basic(x) {
	//if (x === null) return true;
	switch (typeof x) {
		case 'boolean':
		case 'number':
		case 'string': return true;
	}
}

/*
console.log(encode({
	"fruits": [
		{
			"name": "apple",
			"physical": {
				"color": "red",
				"shape": "round"
			},
			"varieties": [
				{ "name": "red delicious" },
				{ "name": "granny smith" }
			]
		},
		{
			"name": "banana",
			"varieties": [
				{ "name": "plantain" }
			]
		}
	]
}));
*/

// https://docs.soliditylang.org/en/latest/grammar.html#a4.SolidityLexer.Identifier

function on_newline(fn) {
	let prior = '';
	return buf => {
		prior += buf.toString();
		let v = prior.split('\n');
		prior = v.pop();
		v.forEach(x => fn(x));
	};
}

function is_pathlike(x) {
	return typeof x === 'string' || x instanceof URL;
}

function remove_sol_ext(s) {
	return s.replace(/\.sol$/, '');
}

const CONFIG_NAME = 'foundry.toml';

function ansi(c, s) {
	return `\x1B[${c}m${s}\u001b[0m`;
}
function strip_ansi(s) {
	return s.replaceAll(/[\u001b][^m]+m/g, ''); //.split('\n');
}

const TAG_START   = ansi('93', 'LAUNCH');
const TAG_DEPLOY  = ansi('33', 'DEPLOY');
const TAG_TX      = ansi('33', 'TX');
const TAG_EVENT   = ansi('36', 'EVENT');
const TAG_CONSOLE = ansi('96', 'LOG');
const TAG_STOP    = ansi('93', 'STOP'); 

const DEFAULT_WALLET = 'admin';
const DEFAULT_PROFILE = 'default';

const Symbol_foundry = Symbol('blocksmith');
const Symbol_name  = Symbol('blocksmith.name');
const Symbol_makeErrors = Symbol('blocksmith.makeError');
function get_NAME() {
	return this[Symbol_name];
}

function take_hash(s) {
	return s.slice(2, 10);
}

function parse_cid(cid) {
	let pos = cid.lastIndexOf(':');
	let contract;
	if (pos == -1) {
		contract = remove_sol_ext(node_path.basename(cid));
	} else {
		contract = remove_sol_ext(cid.slice(pos + 1));
		cid = cid.slice(0, pos);
	}
	let path = cid.split(node_path.sep).reverse();
	return {contract, path};
}

class ContractMap {
	constructor() {
		this.map = new Map();
	}
	add(cid, value) {
		let {contract, path} = parse_cid(cid);
		let bucket = this.map.get(contract);
		if (!bucket) {
			bucket = [];
			this.map.set(contract, bucket);
		}
		bucket.push({path, value});
	}
	find(cid) {
		let {contract, path} = parse_cid(cid);
		let bucket = this.map.get(contract);
		if (bucket) {
			let i = 0;
			for (; bucket.length > 1 && i < path.length; i++) {
				bucket = bucket.filter(x => x.path[i] === path[i]);
			}
			if (bucket.length == 1) {
				let cid = i ? `${path.slice(0, i).reverse().join(node_path.sep)}:${contract}` : contract;
				return [cid, bucket[0].value];
			}
		}
		return [];
	}
}

async function execCmd(cmd, args, env, log) {

	console.log("EXEC", cmd, args);
	let timer;
	if (log) setTimeout(() => log(cmd, args), 5000); // TODO: make this customizable
	return new Promise((ful, rej) => {
		let proc = node_child_process.spawn(cmd, args, {encoding: 'utf8', env});
		let stdout = '';
		let stderr = '';
		proc.stderr.on('data', chunk => {
			stderr += chunk;
			console.log("eCHUNK", chunk);

	});
		proc.stdout.on('data', chunk => {
			console.log("CHUNK", chunk);
			stdout += chunk;
	});
		proc.on('exit', code => {
			try {
				console.log("CODE", code);	
				if (!code) {
					return ful(stdout);
				}
			} catch (err) {
			}
			rej(error_with('unexpected output', {code, error: strip_ansi(stderr), cmd, args}));
		});
	}).finally(() => clearTimeout(timer));
}

async function exec_json(cmd, args, env, log) {

	log?.(cmd, args, env);
	// 20240905: bun bug
	// https://github.com/oven-sh/bun/issues/13755
	// this fix is absolute garbage
	// idea#1: use chunks[0].length != 262144
	// 20240905: doesn't work
	// idea#2: assume json, check for leading curly: /^\s*{/
	// if (process.isBun && stdout.length > 1 && stdout[0][0] !== 0x7B) {
	// 	console.log('out of order', stdout.map(x => x.length));
	// 	let chunk = stdout[0];
	// 	stdout[0] = stdout[1];
	// 	stdout[1] = chunk;
	// }
	// 20240905: just use file until theres a proper fix
	// https://github.com/oven-sh/bun/issues/4798
	// 20240914: had to revert this fix as it causes more bugs than it fixes
	// https://github.com/oven-sh/bun/issues/13972
	// 20240921: another attempt to fix this bun shit
	// just yolo swap the buffers if it parses incorrectly
	try {
		let stdout = await new Promise((ful, rej) => {
			let proc = node_child_process.spawn(cmd, args, {
				env: {...process.env, ...env}, 
				stdio: ['ignore', 'pipe', 'pipe'],
			});
			let stdout = [];
			let stderr = [];
			proc.stdout.on('data', chunk => stdout.push(chunk));
			proc.stderr.on('data', chunk => stderr.push(chunk));
			proc.on('close', code => {
				if (code) {
					let error = Buffer.concat(stderr).toString('utf8');
					error = strip_ansi(error);
					error = error.replaceAll(/^Error:/g, '');
					error = error.trim();
					// 20240916: put more info in message since bun errors are dogshit
					rej(new Error(`${cmd}: ${error} (code=${code})`));
				} else {
					//ful(Buffer.concat(stdout));
					ful(stdout);
				}
			});
		});
		try {
			return JSON.parse(Buffer.concat(stdout));
		} catch (bug) {
			if (stdout.length > 1) {
				let v = stdout.slice();
				v[0] = stdout[1];
				v[1] = stdout[0];
				return JSON.parse(Buffer.concat(v));
			}
			throw bug;
		}
	} catch (err) {
		throw Object.assign(err, {cmd, args, env});
	}
}

async function compile(sol, options = {}) {
	let {
		contract,
		foundry, 
		optimize, 
		autoHeader = true, 
		solcVersion, 
		evmVersion,
		viaIR
	} = options;
	if (Array.isArray(sol)) {
		sol = sol.join('\n');
	}
	if (!contract) {
		let match = sol.match(/(contract|library)\s([a-z$_][0-9a-z$_]*)/i);
		if (!match) throw error_with('expected contract name', {sol});
		contract = match[2];
	}
	if (autoHeader) {
		if (!/^\s*pragma\s+solidity/m.test(sol)) {
			sol = `pragma solidity >=0.0.0;\n${sol}`;
		}
		if (!/^\s*\/\/\s*SPDX-License-Identifier:/m.test(sol)) {
			sol = `// SPDX-License-Identifier: UNLICENSED\n${sol}`;
		}
	}
	let hash = ethers.ethers.id(sol);
	let root = node_path.join(await promises.realpath(node_os.tmpdir()), 'blocksmith', hash);
	
	await promises.rm(root, {recursive: true, force: true}); // better than --force 
	
	let src = node_path.join(root, foundry?.config.src ?? 'src');
	await promises.mkdir(src, {recursive: true});
	let file = node_path.join(src, `${contract}.sol`);
	await promises.writeFile(file, sol);

	let args = [
		'build',
		'--format-json',
		'--root', root,
		'--no-cache',
	];
	
	let env = {FOUNDRY_PROFILE: DEFAULT_PROFILE};
	let config;
	if (foundry) {
		config = JSON.parse(JSON.stringify(foundry.config)); // structuredClone?
		let remappings = [
			['@src', foundry.config.src], // this is nonstandard
			['@test', foundry.config.test],
			...config.remappings.map(s => s.split('='))
		];
		config.remappings = remappings.map(([a, b]) => {
			let pos = a.indexOf(':');
			if (pos >= 0) {
				// support remapping contexts
				a = node_path.join(foundry.root, a.slice(0, pos)) + a.slice(pos);
			}
			return `${a}=${node_path.join(foundry.root, b)}`;
		});
	} else {
		config = {};
	}
	
	// cant use --optimize, no way to turn it off
	let config_file = node_path.join(root, CONFIG_NAME);
	if (optimize !== undefined) {
		if (optimize === true) optimize = 200;
		if (optimize === false) {
			config.optimizer = false;
		} else {
			config.optimizer = true;
			config.optimizer_runs = optimize; // TODO: parse?
		}
	}
	if (solcVersion) config.solc_version = solcVersion;
	if (evmVersion) config.evm_version = evmVersion;
	if (viaIR !== undefined) config.via_ir = !!viaIR;

	await promises.writeFile(config_file, encode({profile: {[DEFAULT_PROFILE]: config}}));
	args.push('--config-path', config_file);

	let res = await exec_json(foundry?.forge ?? 'forge', args, env, foundry?.procLog);
	let errors = filter_errors(res.errors);
	if (errors.length) {
		throw error_with('forge build', {sol, errors});
	}

	let info = res.contracts[file]?.[contract]?.[0];
	let origin = `InlineCode{${take_hash(hash)}}`;
	if (!info) {
		for (let x of Object.values(res.contracts)) {
			let c = x[contract];
			if (c) {
				info = c[0];
				//origin = '@import';
				break;
			}
		}
		if (!info) {
			throw error_with('expected contract', {sol, contracts: Object.keys(res.contracts), contract});
		}
	}
	let {contract: {abi, evm}} = info;
	abi = abi_from_solc_json(abi);
	let bytecode = '0x' + evm.bytecode.object;
	let links = extract_links(evm.bytecode.linkReferences);
	//let deployedBytecode = '0x' + evm.deployedBytecode.object; // TODO: decide how to do this
	//let deployedByteCount = evm.deployedBytecode.object.length >> 1;
	// 20241002: do this is general with a decompiler
	return {abi, bytecode, contract, origin, links, sol, root};
}

// should this be called Foundry?
class FoundryBase extends EventEmitter {
	constructor() {
		super();
	}
	static profile() {
		return process.env.FOUNDRY_PROFILE ?? DEFAULT_PROFILE;
	}
	// should
	static async root(cwd) {
		let dir = await promises.realpath(cwd || process.cwd());
		while (true) {
			let file = node_path.join(dir, 'foundry.toml');
			try {
				await promises.access(file);
				return dir;
			} catch {
			}
			let parent = node_path.dirname(dir);
			if (parent === dir) throw error_with(`expected ${CONFIG_NAME}`, {cwd});
			dir = parent;
		}
	}
	static async load({root, profile, forge = 'forge', ...unknown} = {}) {
		if (Object.keys(unknown).length) {
			throw error_with('unknown options', unknown);
		}
		if (!root) root = await this.root();
		//root = await realpath(root); // do i need this?
		if (!profile) profile = this.profile();
		let config;
		try {
			config = await exec_json(forge, ['config', '--root', root, '--json'], {FOUNDRY_PROFILE: profile}, this.procLog);
		} catch (err) {
			throw error_with(`invalid ${CONFIG_NAME}`, {root, profile}, err);
		}
		return Object.assign(new this, {root, profile, config, forge});
	}
	async build(force) {
		if (!force && this.built) return this.built;
		let args = ['build', '--format-json', '--root', this.root];
		if (force) args.push('--force');
		let res = await exec_json(this.forge, args, {FOUNDRY_PROFILE: this.profile}, this.procLog);

		console.log("RES", res);
		
		let errors = filter_errors(res.errors);
		if (errors.length) {
			throw error_with('forge build', {errors});
		}
		this.emit('built');
		return this.built = {date: new Date()};
	}
	async find({file, contract}) {
		await this.build();
		file = remove_sol_ext(file); // remove optional extension
		if (!contract) contract = node_path.basename(file); // derive contract name from file name
		file += '.sol'; // add extension
		let tail = node_path.join(node_path.basename(file), `${contract}.json`);
		let path = node_path.dirname(file);

		while (true) {
			console.log("PATH", path);

			try {
				let out_file = node_path.join(this.root, this.config.out, path, tail);
				console.log("OUT FILE", out_file);
				await promises.access(out_file);
				return out_file;
			} catch (err) {
				let parent = node_path.dirname(path);
				if (parent === path) throw error_with(`unknown contract: ${file}:${contract}`, {file, contract});
				path = parent;
			}
		}
	}
	compile(sol, options = {}) {
		return compile(sol, {...options, foundry: this});
	}
	resolveArtifact(arg0) {
		let {import: imported, bytecode, abi, sol, file, contract, ...rest} = arg0;
		if (imported) {
			sol = `import "${imported}";`;
			contract ??= remove_sol_ext(node_path.basename(imported));
			rest.autoHeader = true; // force it
		}
		if (bytecode) { // bytecode + abi
			contract ??= 'Unnamed';
			abi = iface_from(abi ?? []);
			return {abi, bytecode, contract, origin: 'Bytecode', links: []};
		} else if (sol) { // sol code + contract?
			return compile(sol, {contract, foundry: this, ...rest});
		} else if (file) { // file + contract?
			return this.fileArtifact({file, contract});
		}
		throw error_with('unknown artifact', arg0);
	}
	// async compileArtifact({sol, contract, ...rest}) {
	// 	return compile(sol, {contract, rest})
	// }
	async fileArtifact(arg0) {
		let file = await this.find(arg0);
		let artifact = JSON.parse(await promises.readFile(file));
		let [origin, contract] = Object.entries(artifact.metadata.settings.compilationTarget)[0]; // TODO: is this correct?
		let bytecode = artifact.bytecode.object;
		let links = extract_links(artifact.bytecode.linkReferences);
		let abi = abi_from_solc_json(artifact.abi);
		return {abi, bytecode, contract, origin, file, links};
	}
	linkBytecode(bytecode, links, libs) {
		let map = new ContractMap();
		for (let [cid, impl] of Object.entries(libs)) {
			console.log("impl", impl);
			let address = to_address(impl);
			if (!address) throw error_with(`unable to determine library address:`, {impl});
			map.add(cid, address);
		}
		let linked = Object.fromEntries(links.map(link => {
			let cid = `${link.file}:${link.contract}`;
			let [prefix, address] = map.find(cid);
			if (!prefix) throw error_with(`unlinked external library: ${cid}`, link);
			for (let offset of link.offsets) {
				offset = (1 + offset) << 1;
				bytecode = bytecode.slice(0, offset) + address.slice(2) + bytecode.slice(offset + 40);
			}
			return [prefix, address];
		}));
		bytecode = ethers.ethers.getBytes(bytecode);
		return {bytecode, linked, libs};
	}
	tomlConfig() {
		return encode({profile: {[this.profile]: this.config}});
	}
	// async deployArtifact() {
	// 	// create server?
	// 	// create static html?
	// }
}

function has_key(x, key) {
	return typeof x === 'object' && x !== null && key in x;
}

class Foundry extends FoundryBase {

	static async launchLive({
		provider,
		wallets = [DEFAULT_WALLET],
		chain,
		procLog,
		infoLog = true,
		...rest
	}) {
		console.log("Launch live");
		let self = await this.load(rest);
		self.provider = provider;

		return self;
	}

	isAnvil() {
		return 'anvil' in this;
	}

	static of(x) {
		if (!has_key(x, Symbol_foundry)) throw new TypeError(`expected Contract or Wallet`);
		return x[Symbol_foundry];
	}

	static async launch({
		port = 0,
		wallets = [DEFAULT_WALLET],
		anvil = 'anvil',
		chain,
		infiniteCallGas,
		gasLimit,
		blockSec,
		autoClose = true,
		fork, 
		procLog,
		infoLog = true,
		...rest
	} = {}) {
		let self = await this.load(rest);
		if (!infoLog) infoLog = undefined;
		if (!procLog) procLog = undefined;
		if (infoLog === true) infoLog = console.log.bind(console);
		// if (infoLog === true) {
		// 	infoLog = (...a) => console.log(ansi('2', new Date().toISOString()), ...a);
		// }
		if (procLog === true) procLog = console.log.bind(console);
		return new Promise((ful, rej) => {
			let args = [
				'--port', port,
				'--accounts', 0, // create accounts on demand
			];
			if (chain) args.push('--chain-id', chain);
			if (blockSec) args.push('--block-time', blockSec);
			if (infiniteCallGas) {
				//args.push('--disable-block-gas-limit');
				// https://github.com/foundry-rs/foundry/pull/6955
				// currently bugged
				// 20240819: still bugged
				// https://github.com/foundry-rs/foundry/pull/8274
				// 20240827: yet another bug
				// https://github.com/foundry-rs/foundry/issues/8759
				if (fork) {
					args.push('--disable-block-gas-limit');
				} else {
					args.push('--gas-limit', '99999999999999999999999');
				}
			} else if (gasLimit) {
				args.push('--gas-limit', gasLimit);
			}
			if (fork) {
				fork = String(fork);
				args.push('--fork-url', fork);
			}
			let proc = node_child_process.spawn(anvil, args, {
				env: {...process.env, RUST_LOG: 'node=info'},
				stdio: ['ignore', 'pipe', 'pipe'],
			});
			const fail = data => {
				proc.kill();
				let error = strip_ansi(data.toString()).trim();
				rej(error_with('launch', {args, error}));
			};
			proc.stderr.once('data', fail);
			let lines = [];
			const waiter = on_newline(line => {
				lines.push(line);
				// 20240319: there's some random situation where anvil doesnt
				// print a listening endpoint in the first stdout flush
				let match = line.match(/^Listening on (.*)$/);
				if (match) init(lines.join('\n'), match[1]);
				// does this need a timeout?
			});
			proc.stdout.on('data', waiter);
			async function init(bootmsg, host) {
				proc.stdout.removeListener('data', waiter);
				proc.stderr.removeListener('data', fail);
				if (autoClose) {
					const kill = () => proc.kill();
					process.on('exit', kill);
					proc.once('exit', () => process.removeListener('exit', kill));
				}
				if (is_pathlike(infoLog)) {
					let console = new node_console.Console(node_fs.createWriteStream(infoLog));
					infoLog = console.log.bind(console);
				}
				if (is_pathlike(procLog)) {
					let out = node_fs.createWriteStream(procLog);
					out.write(bootmsg + '\n');
					proc.stdout.pipe(out);
					procLog = false;
				} else if (procLog) {
					procLog(bootmsg);
				}
				let show_log = true; // 20240811: foundry workaround for gas estimation spam
				proc.stdout.on('data', on_newline(line => {
					// https://github.com/foundry-rs/foundry/issues/7681
					// https://github.com/foundry-rs/foundry/issues/8591
					// [2m2024-08-02T19:38:31.399817Z[0m [32m INFO[0m [2mnode::user[0m[2m:[0m anvil_setLoggingEnabled
					if (infoLog) {
						let match = line.match(/^(\x1B\[\d+m\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\x1B\[0m) \x1B\[\d+m([^\x1B]+)\x1B\[0m \x1B\[\d+m([^\x1B]+)\x1B\[0m\x1B\[2m:\x1B\[0m (.*)$/);
						if (match) {
							let [_, time, _level, kind, line] = match;
							if (kind === 'node::user') {
								// note: this gets all fucky when weaving promises
								// but i dont know of any work around until this is fixed
								show_log = line !== 'eth_estimateGas';
							} else if (kind === 'node::console') {
								if (show_log) {
									self.emit('console', line);
									infoLog(TAG_CONSOLE, time, line);
								}
								return;
							}
						}
					}
					procLog?.(line);
				}));
				let endpoint = `ws://${host}`;
				port = parseInt(host.slice(host.lastIndexOf(':') + 1));
				let provider = new ethers.ethers.WebSocketProvider(endpoint, chain, {staticNetwork: true});
				//let provider = new ethers.IpcSocketProvider('/tmp/anvil.ipc', chain, {staticNetwork: true});
				chain ??= parseInt(await provider.send('eth_chainId')); // determine chain id
				let automine = await provider.send('anvil_getAutomine');
				if (automine) {
					provider.destroy();
					provider = new ethers.ethers.WebSocketProvider(endpoint, chain, {staticNetwork: true, cacheTimeout: -1});
				}
				Object.assign(self, {proc, provider, infoLog, procLog, endpoint, chain, port, automine, anvil, fork});
				wallets = await Promise.all(wallets.map(x => self.ensureWallet(x)));
				if (infoLog) {
					const t = Date.now();
					infoLog(TAG_START, self.pretty({chain, endpoint, wallets}));
					proc.once('exit', () => {
						const uptime = Date.now() - t;
						self.emit('shutdown', uptime);
						infoLog(TAG_STOP, `${ansi('33', uptime)}ms`); // TODO fix me
					});
				}
				ful(self);
			}
		});
	}
	constructor() {
		super();
		this.accounts = new Map();
		this.write_map = new Map();
		this.event_map = new Map();
		const error_map = this.error_map = new Map();
		this.wallets = {};
		this.error_fixer = function(data, tx) {
			const error0 = this[Symbol_makeErrors](data, tx);
			if (!error0.reason) {
				let bucket = error_map.get(ethers.ethers.dataSlice(data, 0, 4));
				if (bucket) {
					for (let abi of bucket.values()) {
						let error = abi.makeError(data, tx);
						if (error.reason) {
							error.invocation ??= error0.invocation;
							return error;
						}
					}
				}
			}
			return error0;
		};
		this.shutdown = () => {
			if (!this.killed) {
				this.killed = new Promise(ful => {
					this.provider.destroy();
					this.proc.once('exit', ful);
					this.proc.kill();
				});
			}
			return this.killed;
		};
	}
	nextBlock(n = 1) {
		return this.provider.send('anvil_mine', [ethers.ethers.toBeHex(n)]);
	}
	setStorageValue(a, slot, value) {
		if (value instanceof Uint8Array) {
			if (value.length != 32) throw new TypeError(`expected exactly 32 bytes`);
			value = ethers.ethers.hexlify(value);
		} else {
			value = ethers.ethers.toBeHex(value, 32);
		}
		return this.provider.send('anvil_setStorageAt', [to_address(a), ethers.ethers.toBeHex(slot, 32), value]);
	}
	setStorageBytes(a, slot, v) {
		// TODO: this does not cleanup (zero higher slots)
		a = to_address(a);
		v = ethers.ethers.getBytes(v);
		if (v.length < 32) {
			let u = new Uint8Array(32);
			u.set(v);
			u[31] = v.length << 1;
			return this.setStorageValue(a, slot, u);
		}
		slot = BigInt(slot);
		let ps = [this.setStorageValue(a, slot, (v.length << 1) | 1)];
		let off = BigInt(ethers.ethers.solidityPackedKeccak256(['uint256'], [slot]));
		let pos = 0;
		while (pos < v.length) {
			let end = pos + 32;
			if (end > v.length) {
				let u = new Uint8Array(32);
				u.set(v.subarray(pos));
				ps.push(this.setStorageValue(a, off, u));
				break;
			}
			ps.push(this.setStorageValue(a, off++, v.subarray(pos, end)));
			pos = end;
		}
		return Promise.all(ps);
	}
	requireWallet(...xs) {
		for (let x of xs) {
			if (!x) continue;
			if (x instanceof ethers.ethers.Wallet) {
				if (x[Symbol_foundry] === this) return x;
				throw error_with('unowned wallet', {wallet: x});
			}
			let address = to_address(x);
			if (address) {
				let a = this.accounts.get(address);
				if (a) return a;
			} else if (typeof x === 'string') {
				let a = this.wallets[x];
				if (a) return a;
			}
			throw error_with('expected wallet', {wallet: x});
		}
		throw new Error('missing required wallet');
	}
	createWallet({prefix = 'random', ...a} = {}) {
		let id = 0;
		while (true) {
			let name = `${prefix}${++id}`; // TODO fix O(n)
			if (!this.wallets[name]) {
				return this.ensureWallet(name, a);
			}
		}
	}
	async ensureWallet(x, {ether = 10000} = {}) {
		if (x instanceof ethers.ethers.Wallet) return this.requireWallet(x);
		if (!x || typeof x !== 'string' || is_address(x)) {
			throw error_with('expected wallet name', {name: x});
		}
		let wallet = this.wallets[x];
		if (!wallet) {
			wallet = new ethers.ethers.Wallet(ethers.ethers.id(x), this.provider);
			ether = BigInt(ether);
			if (ether > 0) {
				await this.provider.send('anvil_setBalance', [wallet.address, ethers.ethers.toBeHex(ether * BigInt(1e18))]);
			}
			wallet[Symbol_name] = x;
			wallet[Symbol_foundry] = this;
			wallet.toString = get_NAME;
			this.wallets[x] = wallet;
			this.accounts.set(wallet.address, wallet);
		}
		return wallet;
	}
	pretty(x) {
		if (x) {
			if (typeof x === 'object') {
				if (Symbol_foundry in x) {
					return {
						[node_util.inspect.custom]() { 
							return ansi('35', x[Symbol_name]);
						}
					};
				} else if (x instanceof ethers.ethers.Indexed) {
					return {
						[node_util.inspect.custom]() { 
							return ansi('36', `'${x.hash}'`);
						}
					};
				} else if (Array.isArray(x)) {
					return x.map(y => this.pretty(y));
				} else if (x.constructor === Object) {
					return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, this.pretty(v)]));
				}
			} else if (typeof x === 'string') {
				if (is_address(x)) {
					let a = this.accounts.get(x);
					if (a) return this.pretty(a);
				}
			}
		}
		return x;
	}
	parseError(err) {
		// TODO: fix me
		if (err.code === 'CALL_EXCEPTION') {
			let {data} = err;
			console.log(this.error_map);
			let bucket = this.error_map.get(data.slice(0, 10));
			console.log('bucket', bucket);
			if (bucket) {
				for (let abi of bucket.values()) {
					try {
						return abi.parseError(data);
					} catch (err) {
					}
				}
			}
		}
	}
	parseTransaction(tx) {
		let bucket = this.write_map.get(tx.data?.slice(0, 10));
		if (!bucket) return;
		for (let abi of bucket.values()) {
			let desc = abi.parseTransaction(tx);
			if (desc) return desc;
		}
	}
	async confirm(p, {silent, ...extra} = {}) {
		let tx = await p;
		let receipt = await tx.wait();
		let desc = this.parseTransaction(tx);
		if (!silent && this.infoLog) {
			let args = {gas: receipt.gasUsed, ...extra};
			let action;
			if (desc) {
				Object.assign(args, desc.args.toObject());
				action = desc.signature;
			} else if (tx.data?.length >= 10) {
				action = ansi('90', tx.data.slice(0, 10));
				if (tx.data.length > 10) {
					args.calldata = '0x' + tx.data.slice(10);
				}
			}
			if (tx.value > 0) {
				args.value = tx.value;
			}
			if (action) {
				this.infoLog(TAG_TX, this.pretty(receipt.from), '>>', this.pretty(receipt.to), action, this.pretty(args));
			} else {
				this.infoLog(TAG_TX, this.pretty(receipt.from), '>>', this.pretty(receipt.to), this.pretty(args));
			}
			this._dump_logs(receipt);
		}
		this.emit('tx', tx, receipt, desc);
		return receipt;
	}
	_dump_logs(receipt) {
 		for (let x of receipt.logs) {
			let abi = this.event_map.get(x.topics[0]);
			let event;
			if (abi) {
				event = abi.parseLog(x);
			}
			if (event) {
				if (event.args.length) {
					this.infoLog(TAG_EVENT, event.signature, this.pretty(event.args.toObject()));
				} else {
					this.infoLog(TAG_EVENT, event.signature);
				}
			}
		}
	}
	async deployed({from, at, ...artifactLike}) {
		// TODO: expose this
		let w = await this.ensureWallet(from || DEFAULT_WALLET);
		let {abi, ...artifact} = await this.resolveArtifact(artifactLike);
		let c = new ethers.ethers.Contract(at, abi, w);
		c[Symbol_name] = `${artifact.contract}<${take_hash(c.target)}>`; 
		c[Symbol_foundry] = this;
		c.toString = get_NAME;
		c.__artifact = artifact;
		this.accounts.set(c.target, c);
		return c;
	}

	async deploy(arg0) {
		if (typeof arg0 === 'string') {
			arg0 = arg0.startsWith('0x') ? {bytecode: arg0} : {sol: arg0};
		}
		let {
			from = DEFAULT_WALLET, 
			args = [], 
			libs = {}, 
			abis = [], 
			silent = false, 
			parseAllErrors = true, 
			prepend = '',
			...artifactLike
		} = arg0;
		from = this.isAnvil() ? await this.ensureWallet(from) : from;
		const { chainId } = await from.provider.getNetwork();
		let {abi, links, bytecode: bytecode0, origin, contract} = await this.resolveArtifact(artifactLike);
		abi = mergeABI(abi, ...abis);
		if (parseAllErrors) abi = this.parseAllErrors(abi);

		console.log("Links", links);

		if (!this.isAnvil()) {
			const deployment = await loadDeployment(this.root, chainId, prepend, contract);

			if (deployment && 'target' in deployment) {
				const deployedContract = new ethers.ethers.Contract(deployment.target, deployment.abi, from);

				deployedContract.already = true;
				deployedContract.constructorArgs = deployment.constructorArgs;
				deployedContract.links = deployment.links;

				return deployedContract;
			}
		}

		let {bytecode, linked} = this.linkBytecode(bytecode0, links, libs);
		let factory = new ethers.ethers.ContractFactory(abi, bytecode, from);
		let unsigned = await factory.getDeployTransaction(...args);
		let tx = await from.sendTransaction(unsigned);
		let receipt = await tx.wait();

		//Save deployment data for live deployments
		if (!this.isAnvil()) {
			const contractData = {
				"name": contract, 
				"target": receipt.contractAddress, 
				// Save the minimal ABI
				// 20241025 ethers.js was failing to parse complex tuple arrays when using fragments
				"abi": abi.format(true), 
				"bytecode": bytecode, 
				"links": links, 
				"receipt": receipt, 
				"constructorArgs": args
			};
			await saveDeployment(this.root, chainId, prepend, contractData);
		}

		let c = new ethers.ethers.Contract(receipt.contractAddress, abi, from);
		c["constructorArgs"] = args;
		c["links"] = links;
		c[Symbol_name] = `${contract}<${take_hash(c.target)}>`; // so we can deploy the same contract multiple times
		c[Symbol_foundry] = this;
		c.toString = get_NAME;
		let code = ethers.ethers.getBytes(await this.provider.getCode(c.target));
		c.__info = {contract, origin, code, libs: linked, from};
		c.__receipt = receipt;
		this.accounts.set(c.target, c);
		abi.forEachFunction(f => {
			if (f.constant) return;
			let bucket = this.write_map.get(f.selector);
			if (!bucket) {
				bucket = new Map();
				this.write_map.set(f.selector, bucket);
			}
			bucket.set(f.format('sighash'), abi);
		});
		abi.forEachEvent(e => this.event_map.set(e.topicHash, abi));
		abi.forEachError(e => {
			let bucket = this.error_map.get(e.selector);
			if (!bucket) {
				bucket = new Map();
				this.error_map.set(e.selector, bucket);
			}
			bucket.set(ethers.ethers.id(e.format('sighash')), abi);
		});
		if (!silent && this.infoLog) {
			let stats = [
				`${ansi('33', receipt.gasUsed)}gas`, 
				`${ansi('33', code.length)}bytes`
			];
			if (Object.keys(linked).length) {
				stats.push(this.pretty(linked));
			}
			this.infoLog(TAG_DEPLOY, this.pretty(from), origin, this.pretty(c), ...stats);
			this._dump_logs(receipt);
		}
		this.emit('deploy', c); // tx, receipt?
		return c;
	}
	parseAllErrors(abi) {
		if (abi.makeError !== this.error_fixer) {
			abi[Symbol_makeErrors] = abi.makeError.bind(abi);
			abi.makeError = this.error_fixer;
		}
		return abi;
	}
}

function abi_from_solc_json(json) {
	// purge stuff that ethers cant parse
	// TODO: check that this is an external library
	// https://github.com/ethereum/solidity/issues/15470
	let v = [];
	for (let x of json) {
		try {
			v.push(ethers.ethers.Fragment.from(x));
		} catch (err) {
		}
	}
	return new ethers.ethers.Interface(v);
}

function iface_from(x) {
	return x instanceof ethers.ethers.BaseContract ? x.interface : ethers.ethers.Interface.from(x);
}

function mergeABI(...a) {
	if (a.length < 2) return iface_from(a[0] ?? []);
	let unique = new Map();
	let extra = [];
	a.forEach((x, i) => {
		for (let f of iface_from(x).fragments) {
			switch (f.type) {
				case 'constructor':
				case 'fallback':
					if (!i) extra.push(f);
					break;
				case 'function':
				case 'event':
				case 'error': // take all
					let key = `${f.type}:${f.format()}`;
					if (key && !unique.has(key)) {
						unique.set(key, f);
					}
					break;
			}
		}
	});
	return new ethers.ethers.Interface([...extra, ...unique.values()]);
}

function filter_errors(errors) {
	return errors.filter(x => x.severity === 'error');
}

function extract_links(linkReferences) {
	return Object.entries(linkReferences).flatMap(([file, links]) => {
		return Object.entries(links).map(([contract, ranges]) => {
			let offsets = ranges.map(({start, length}) => {
				if (length != 20) throw error_with(`expected 20 bytes`, {file, contract, start, length});
				return start;
			});
			return {file, contract, offsets};
		});
	});
}

console.log("Hello");
async function saveDeployment(root, chainId, savePrepend, data) {

	let src = node_path.join(root, 'deployments', chainId.toString());
	console.log("Saving src", src);
	await promises.mkdir(src, {recursive: true});
	let file = node_path.join(src, `${savePrepend}${data.name}.json`);
	await promises.writeFile(file, JSON.stringify(data));
}


async function loadDeployment(root, chainId, savePrepend, name) {
	let file = node_path.join(root, 'deployments', chainId.toString(), `${savePrepend}${name}.json`);
	console.log("Reading src", file);

	try {
		let data = await promises.readFile(file);
		return JSON.parse(data);
	} catch (e) {
		return false;
	}
}

function split(s) {
	return s ? s.split('.') : [];
}

class Node extends Map {
	static create(name) {
		return name instanceof this ? name : this.root().create(name);
	}
	static root(tag = 'root') {
		return new this(null, ethers.ethers.ZeroHash, `[${tag}]`);
	}
	constructor(parent, namehash, label, labelhash) {
		super();
		this.parent = parent;
		this.namehash = namehash;
		this.label = label;
		this.labelhash = labelhash;
	}
	get dns() {
		return ethers.ethers.getBytes(ethers.ethers.dnsEncode(this.name, 255));
	}
	get name() {
		if (!this.parent) return '';
		let v = [];
		for (let x = this; x.parent; x = x.parent) v.push(x.label);
		return v.join('.');
	}
	get depth() {
		let n = 0;
		for (let x = this; x.parent; x = x.parent) ++n;
		return n;
	}
	get nodeCount() {
		let n = 0;
		this.scan(() => ++n);
		return n;
	}
	get root() {
		let x = this;
		while (x.parent) x = x.parent;
		return x;
	}
	get isETH2LD() {
		return this.parent?.name === 'eth';
	}
	path(inc_root) {
		// raffy.eth => [raffy.eth, eth, <root>?]
		let v = [];
		for (let x = this; inc_root ? x : x.parent; x = x.parent) v.push(x);
		return v;
	}
	find(name) {
		return split(name).reduceRight((n, s) => n?.get(s), this);
	}
	create(name) {
		return split(name).reduceRight((n, s) => n.child(s), this);
	}
	child(label) {
		let node = this.get(label);
		if (!node) {
			let labelhash = ethers.ethers.id(label);
			let namehash = ethers.ethers.solidityPackedKeccak256(['bytes32', 'bytes32'], [this.namehash, labelhash]);
			node = new this.constructor(this, namehash, label, labelhash);
			this.set(label, node);
		}
		return node;
	}
	unique(prefix = 'u') {
		for (let i = 1; ; i++) {
			let label = prefix + i;
			if (!this.has(label)) return this.child(label);
		}
	}
	scan(fn, level = 0) {
		fn(this, level++);
		for (let x of this.values()) {
			x.scan(fn, level);
		}
	}
	flat() {
		let v = [];
		this.scan(x => v.push(x));
		return v;
	}
	toString() {
		return this.name;
	}
	print(format = x => x.label) {
		this.scan((x, n) => console.log('  '.repeat(n) + format(x)));
	}
}

//import {Node} from './Node.js';

const IFACE_ENSIP_10 = '0x9061b923';
const IFACE_TOR = '0x73302a25';

const RESOLVER_ABI = new ethers.ethers.Interface([
	'function supportsInterface(bytes4) view returns (bool)',
	'function resolve(bytes name, bytes data) view returns (bytes)',
	'function addr(bytes32 node, uint coinType) view returns (bytes)',
	'function addr(bytes32 node) view returns (address)',
	'function text(bytes32 node, string key) view returns (string)',
	'function contenthash(bytes32 node) view returns (bytes)',
	'function pubkey(bytes32 node) view returns (bytes32 x, bytes32 y)',
	'function name(bytes32 node) view returns (string)',
	'function multicall(bytes[] calldata data) external returns (bytes[] memory results)',
]);

const DEFAULT_RECORDS = [
	{type: 'text', arg: 'name'},
	{type: 'text', arg: 'avatar'},
	{type: 'text', arg: 'description'},
	{type: 'text', arg: 'url'},
	{type: 'addr', arg: 60},
	{type: 'addr', arg: 0},
	{type: 'contenthash'},
];

class Resolver {
	static get ABI() {
		return RESOLVER_ABI;
	}
	static async dump(ens, node) {
		let nodes = node.flat();
		let owners = await Promise.all(nodes.map(x => ens.owner(x.namehash)));
		let resolvers = await Promise.all(nodes.map(x => ens.resolver(x.namehash)));
		let width = String(nodes.length).length;
		for (let i = 0; i < nodes.length; i++) {
			console.log(i.toString().padStart(width), owners[i], resolvers[i], nodes[i].name);
		}
	}
	static async get(ens, node) {
		for (let base = node, drop = 0; base; base = base.parent, drop++) {
			let resolver = await ens.resolver(base.namehash);
			if (resolver === ethers.ethers.ZeroAddress) continue;
			let contract = new ethers.ethers.Contract(resolver, RESOLVER_ABI, ens.runner.provider);
			let wild = await contract.supportsInterface(IFACE_ENSIP_10).catch(() => false);
			if (drop && !wild) break;
			let tor = wild && await contract.supportsInterface(IFACE_TOR);
			return Object.assign(new this(node, contract), {wild, tor, drop, base});
		}
	}
	constructor(node, contract) {
		this.node = node;
		this.contract = contract;
	}
	get address() {
		return this.contract.target;
	}
	async text(key, a)   { return this.record({type: 'text', arg: key}, a); }
	async addr(type, a)  { return this.record({type: 'addr', arg: type}, a); }
	async contenthash(a) { return this.record({type: 'contenthash'}, a); }
	async name(a)        { return this.record({type: 'name'}, a); }
	async record(rec, a) {
		let [[{res, err}]] = await this.records([rec], a);
		if (err) throw err;
		return res;
	}
	async records(recs, {multi = true, ccip = true, tor: tor_prefix} = {}) {
		const options = {enableCcipRead: ccip};
		const {node, contract, wild, tor} = this;
		const {interface: abi} = contract;
		let dnsname = ethers.ethers.dnsEncode(node.name, 255);
		if (multi && recs.length > 1 && wild && tor) {
			let encoded = recs.map(rec => {
				let frag = abi.getFunction(type_from_record(rec));
				let params = [node.namehash];
				if ('arg' in rec) params.push(rec.arg);
				return abi.encodeFunctionData(frag, params);
			});
			// TODO: add external multicall
			let frag = abi.getFunction('multicall');
			let call = add_tor_prefix(tor_prefix, abi.encodeFunctionData(frag, [encoded]));	
			let data = await contract.resolve(dnsname, call, options);
			let [answers] = abi.decodeFunctionResult(frag, data);
			return [recs.map((rec, i) => {
				let frag = abi.getFunction(type_from_record(rec));
				let answer = answers[i];
				try {
					let res = abi.decodeFunctionResult(frag, answer);
					if (res.length === 1) res = res[0];
					return {rec, res};
				} catch (err) {
					return {rec, err};
				}
			}), true];
		}
		return [await Promise.all(recs.map(async rec => {
			let params = [node.namehash];
			if (rec.arg) params.push(rec.arg);
			try {
				let type = type_from_record(rec);
				let res;
				if (wild) {
					let frag = abi.getFunction(type);
					let call = abi.encodeFunctionData(frag, params);
					if (tor) call = add_tor_prefix(tor_prefix, call);
					let answer = await contract.resolve(dnsname, call, options);
					res = abi.decodeFunctionResult(frag, answer);
					if (res.length === 1) res = res[0];
				} else {
					res = await contract[type](...params);
				}
				return {rec, res};
			} catch (err) {
				return {rec, err};
			}
		}))];
	}
	async profile(records = DEFAULT_RECORDS, a) {
		let [v, multi] = await this.records(records, a);
		let obj = Object.fromEntries(v.map(({rec, res, err}) => [key_from_record(rec), err ?? res]));
		if (multi) obj.multicalled = true;
		return obj;
	}
}

function type_from_record(rec) {
	let {type, arg} = rec;
	if (type === 'addr') type = arg === undefined ? 'addr(bytes32)' : 'addr(bytes32,uint256)';
	return type;
}

function key_from_record(rec) {
	let {type, arg} = rec;
	switch (type) {
		case 'addr': return `addr${arg ?? ''}`;
		case 'text': return arg;
		default: return type;
	}
}

function add_tor_prefix(prefix, call) {
	switch (prefix) {
		case 'off': return '0x000000FF' + call.slice(2);
		case 'on':  return '0xFFFFFF00' + call.slice(2);
		case undefined: return call;
		default: throw new Error(`unknown prefix: ${prefix}`);
	}
}

exports.Foundry = Foundry;
exports.FoundryBase = FoundryBase;
exports.Node = Node;
exports.Resolver = Resolver;
exports.compile = compile;
exports.error_with = error_with;
exports.execCmd = execCmd;
exports.is_address = is_address;
exports.mergeABI = mergeABI;
exports.to_address = to_address;
