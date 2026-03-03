require('@nomiclabs/hardhat-ethers');

module.exports = {
    solidity: {
        version: '0.8.19',
        settings: {
            evmVersion: 'london',
            viaIR: true,
            optimizer: {
                enabled: true,
                runs: 1000,
            },
        },
    },
    paths: {
        sources: './evm-contracts',
        artifacts: './artifacts',
    },
};
