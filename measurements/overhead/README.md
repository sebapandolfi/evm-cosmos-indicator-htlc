# Semantic-layer overhead of lockForBurn

Measures the gas that the semantic layer adds to `lockForBurn` by deploying,
on a local fork of Polygon mainnet with the real Axelar gateway and gas
service, the evaluated `BridgeHTLC` (tag `v1.0-tesis`) next to a variant that
is identical except for the semantic layer (`BridgeHTLCNoSemantic.sol`; exact
diff in `variant.diff`).

Reproduce (from the repository root, at tag v1.0-tesis):

    cp measurements/overhead/BridgeHTLCNoSemantic.sol evm-contracts/
    cp measurements/overhead/measure-overhead.js scripts/
    # in hardhat.config.js, enable forking for the hardhat network:
    #   networks: { hardhat: { forking: { url: process.env.FORK_URL }, chainId: 137, hardfork: 'shanghai' } }
    FORK_URL=<polygon RPC> npx hardhat run scripts/measure-overhead.js

`RESULTS.md` reports the measured values; `mainnet-trace-run100.json` is the
callTracer trace of campaign run 100 used to attribute the gas of
`lockForBurn` to its external calls.
