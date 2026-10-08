const { Gateway, Wallets } = require('fabric-network');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

async function connectToNetwork() {
    // 1. 加载连接配置文件
    const ccpPath = path.resolve(__dirname, process.env.FABRIC_CONNECTION_PROFILE);
    const ccp = JSON.parse(fs.readFileSync(ccpPath, 'utf8'));

    // 2. 使用内存钱包（避开文件系统钱包的路径解析问题）
    const wallet = await Wallets.newInMemoryWallet();

    // 3. 动态读取证书和私钥文件的路径
    const certDir = path.join(__dirname, 'fabric-config', 'wallet', 'appUser', 'signcerts');
    const keyDir = path.join(__dirname, 'fabric-config', 'wallet', 'appUser', 'keystore');
    
    const certFile = fs.readdirSync(certDir)[0]; // 读取证书目录下的第一个文件
    const keyFile = fs.readdirSync(keyDir)[0];   // 读取私钥目录下的第一个文件

    // 4. 读取文件内容
    const cert = fs.readFileSync(path.join(certDir, certFile)).toString();
    const key = fs.readFileSync(path.join(keyDir, keyFile)).toString();

    // 5. 手动构造身份对象
    const identity = {
        credentials: { certificate: cert, privateKey: key },
        mspId: 'Org1MSP',  // 必须是 Org1MSP
        type: 'X.509'
    };

    // 6. 将身份放入钱包
    await wallet.put('appUser', identity);

    // 7. 创建网关并连接
    const gateway = new Gateway();
    await gateway.connect(ccp, {
        wallet,
        identity: 'appUser',
        discovery: { enabled: true, asLocalhost: true }
    });

    // 8. 获取网络和合约
    const network = await gateway.getNetwork(process.env.FABRIC_CHANNEL);
    const contract = network.getContract(process.env.FABRIC_CHAINCODE);

    return { gateway, contract };
}

module.exports = { connectToNetwork };