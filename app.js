const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
require('dotenv').config();
const { connectToNetwork } = require('./fabric-utils');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

// MySQL 连接池
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    timezone: '+08:00'
});

// 健康检查接口
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', message: 'Agri-Solar-Terms Backend is running' });
});

    // 核心业务：录入气象数据并存证到区块链（模拟传感器存证）

    app.post('/api/data/store', async (req, res) => {
        const { farmId, termId, temperature, humidity, rainfall, timestamp } = req.body;
        if (!farmId || !termId || !temperature || !humidity || !rainfall || !timestamp) {
            return res.status(400).json({ error: '缺少必要参数' });
        }
        try {
            // 1. 先查询当前最大 ID
            const [maxIdRows] = await pool.execute('SELECT MAX(id) AS maxId FROM meteorological_data');
            const newDataId = (maxIdRows[0].maxId || 0) + 1;
            const chainDataId = 'data' + newDataId.toString().padStart(3, '0');

            // 🌟 2. 计算与链码逻辑一致的 SHA-256 哈希
            const rawData = chainDataId + farmId + termId + temperature + humidity + rainfall;
            const dataHash = crypto.createHash('sha256').update(rawData).digest('hex');

            // 3. 写入 MySQL 数据库（包含 data_hash）
            const insertSql = `INSERT INTO meteorological_data (id, farmland_id, solar_term_id, temperature, humidity, rainfall, record_time, data_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
            await pool.execute(insertSql, [newDataId, farmId, termId, temperature, humidity, rainfall, timestamp, dataHash]);
            
            // 4. 调用区块链链码进行存证
            const { gateway, contract } = await connectToNetwork();
            const result = await contract.submitTransaction('StoreMetData', chainDataId, farmId.toString(), termId.toString(), temperature.toString(), humidity.toString(), rainfall.toString(), timestamp);
            await gateway.disconnect();

            res.json({ success: true, message: '数据录入并上链成功', blockchainResult: result.toString(), newDataId: newDataId });
        } catch (error) {
            console.error('存证失败:', error);
            res.status(500).json({ error: '存证失败', details: error.message });
        }
    });

// 核心业务：根据数据 ID 查询链上存证
app.get('/api/data/query/:dataId', async (req, res) => {
    const { dataId } = req.params;
    try {
        // 新增：先检查 MySQL 中是否存在该数据（dataId 格式如 data109，需提取数字）
        const numericId = parseInt(dataId.replace('data', ''));
        const [rows] = await pool.execute('SELECT * FROM meteorological_data WHERE id = ?', [numericId]);
        if (rows.length === 0) {
            return res.status(404).json({ error: '链下业务数据已删除，但链上存证依然存在。这体现了区块链不可篡改的特性。' });
        }

        const { gateway, contract } = await connectToNetwork();
        // ...
        const result = await contract.evaluateTransaction('QueryMetData', dataId);
        await gateway.disconnect();
        const resultJson = JSON.parse(result.toString());
        res.json({ success: true, data: resultJson });
    } catch (error) {
        console.error('查询失败:', error);
        res.status(500).json({ error: '查询失败', details: error.message });
    }
});

// 获取系统统计数据
app.get('/api/stats', async (req, res) => {
    try {
        const [farmRows] = await pool.execute('SELECT COUNT(*) AS count FROM farmlands');
        const [dataRows] = await pool.execute('SELECT COUNT(*) AS count FROM meteorological_data');
        const [chainRows] = await pool.execute('SELECT COUNT(*) AS count FROM blockchain_records');
        const [userRows] = await pool.execute('SELECT COUNT(*) AS count FROM users');
        res.json({
            success: true,
            data: {
                farmlands: farmRows[0].count,
                meteorological: dataRows[0].count,
                blockchain: chainRows[0].count,
                users: userRows[0].count
            }
        });
    } catch (error) {
        res.status(500).json({ error: '获取统计数据失败', details: error.message });
    }
});

// 获取气象数据列表（农户端、气象数据管理用）
app.get('/api/data/list', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT * FROM meteorological_data ORDER BY id DESC');
        res.json({ success: true, data: rows });
    } catch (error) {
        res.status(500).json({ error: '获取气象数据失败' });
    }
});

// 获取用户列表（管理员端、专家端关联姓名用）
app.get('/api/users', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT id, username, role, real_name, phone, created_at FROM users LIMIT 50');
        res.json({ success: true, data: rows });
    } catch (error) {
        res.status(500).json({ error: '获取用户列表失败' });
    }
});

// 获取农事建议列表（专家端用）
app.get('/api/suggestions', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT * FROM agri_suggestions ORDER BY id DESC');
        res.json({ success: true, data: rows });
    } catch (error) {
        res.status(500).json({ error: '获取农事建议失败' });
    }
});

// 发布农事建议（专家端用）
app.post('/api/suggestions', async (req, res) => {
    const { solar_term_id, crop_type, suggestion_content, expert_id } = req.body;
    if (!solar_term_id || !crop_type || !suggestion_content || !expert_id) {
        return res.status(400).json({ error: '缺少必要参数' });
    }
    try {
        const insertSql = `INSERT INTO agri_suggestions (solar_term_id, crop_type, suggestion_content, expert_id, created_at) VALUES (?, ?, ?, ?, NOW())`;
        const [result] = await pool.execute(insertSql, [solar_term_id, crop_type, suggestion_content, expert_id]);
        res.json({ success: true, message: '建议发布成功', insertId: result.insertId });
    } catch (error) {
        console.error('发布建议失败:', error);
        res.status(500).json({ error: '发布建议失败', details: error.message });
    }
});

// 删除农事建议（专家端用）
app.delete('/api/suggestions/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.execute('DELETE FROM agri_suggestions WHERE id = ?', [id]);
        res.json({ success: true, message: '建议已删除' });
    } catch (error) {
        console.error('删除建议失败:', error);
        res.status(500).json({ error: '删除建议失败', details: error.message });
    }
});

// 获取节气列表（前端翻译节气名称、节气管理页面用）
app.get('/api/solar_terms', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT * FROM solar_terms LIMIT 72');
        res.json({ success: true, data: rows });
    } catch (error) {
        res.status(500).json({ error: '获取节气列表失败' });
    }
});

// 获取农田列表（气象数据管理、农户端关联地点用）
app.get('/api/farmlands', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT * FROM farmlands LIMIT 50');
        res.json({ success: true, data: rows });
    } catch (error) {
        res.status(500).json({ error: '获取农田列表失败' });
    }
});

// 获取访问日志列表（管理员端、审计追踪用）
app.get('/api/access_logs', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT * FROM access_logs ORDER BY id DESC LIMIT 80');
        res.json({ success: true, data: rows });
    } catch (error) {
        res.status(500).json({ error: '获取访问日志失败' });
    }
});

// 获取最近的上链足迹（用于首页动态展示，限制5条）
app.get('/api/blockchain/latest', async (req, res) => {
    try {
        const [rows] = await pool.execute(
            'SELECT id, data_id, tx_id, timestamp, status FROM blockchain_records ORDER BY id DESC LIMIT 5'
        );
        res.json({ success: true, data: rows });
    } catch (error) {
        res.status(500).json({ error: '获取上链足迹失败' });
    }
});

// 🌟 获取全量区块链存证记录（用于“全量存证记录”页面）
app.get('/api/blockchain/all', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT * FROM blockchain_records ORDER BY id DESC');
        res.json({ success: true, data: rows });
    } catch (error) {
        res.status(500).json({ error: '获取全量存证记录失败' });
    }
});

// 🌟 获取未上链的数据统计（用于“同步与存证工具”页面）
app.get('/api/data/unlinked-stats', async (req, res) => {
    try {
        const [totalRows] = await pool.execute('SELECT COUNT(*) AS count FROM meteorological_data');
        const [linkedRows] = await pool.execute('SELECT COUNT(*) AS count FROM blockchain_records');
        const total = totalRows[0].count;
        const linked = linkedRows[0].count;
        res.json({ success: true, data: { total, linked, unlinked: total - linked } });
    } catch (error) {
        res.status(500).json({ error: '获取统计失败' });
    }
});

// 🌟 批量将 MySQL 中的气象数据同步到区块链（完善逻辑）
// 🌟 批量将 MySQL 中的气象数据同步到区块链（后台异步执行，前台秒回）
app.post('/api/data/sync-all', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT * FROM meteorological_data');
        const [linkedRows] = await pool.execute('SELECT data_id FROM blockchain_records');
        const linkedIds = linkedRows.map(item => item.data_id);

        // 🌟 立刻给前端返回响应，告诉它任务已启动
        res.json({ success: true, message: '批量同步任务已在后台启动，请稍后查看最新数据。' });

        // 🌟 接下来在后台异步执行（不阻塞前端）
        (async () => {
            try {
                const { gateway, contract } = await connectToNetwork();
                for (const row of rows) {
                    if (linkedIds.includes(row.id)) continue; // 跳过已上链的
                    const dataId = 'data' + row.id.toString().padStart(3, '0');
                    try {
                        // 1. 调用链码进行上链
                        await contract.submitTransaction(
                            'StoreMetData', dataId, row.farmland_id.toString(), row.solar_term_id.toString(),
                            row.temperature.toString(), row.humidity.toString(), row.rainfall.toString(),
                            new Date().toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }).replace(/\//g, '-')
                        );
                        
                        // 🌟 2. 核心修复：上链成功后，将记录插入 MySQL 的 blockchain_records 表
                        // 这样前端的轮询接口 /api/data/unlinked-stats 才能计算出未上链数量为 0
                        const insertBlockchainSql = `INSERT INTO blockchain_records (data_id, tx_id, block_number, contract_address, timestamp, status) VALUES (?, ?, ?, ?,DATE_ADD(NOW(), INTERVAL 8 HOUR), ?)`;
                        await pool.execute(insertBlockchainSql, [
                            row.id, 
                            'batch_tx_' + Date.now(), // 暂时使用时间戳作为交易哈希
                            0, // 区块号暂时填0，因为获取真实区块号需要额外查询
                            'batch_contract', // 合约地址暂填
                             // 当前时间
                            'stored' // 状态
                        ]);
                        console.log(`数据 ID: ${row.id} 上链并写入数据库成功！`);
                        
                    } catch (err) {
                        console.error(`数据 ID: ${row.id} 单条上链失败:`, err.message);
                    }
                }
                await gateway.disconnect();
                console.log('后台批量上链任务执行完毕！');
            } catch (error) {
                // 🌟 捕获整个异步任务的大错误，防止 Node.js 进程崩溃
                console.error('批量同步执行过程中发生严重错误:', error.message);
            }
        })();

    } catch (error) {
        console.error('批量上链失败:', error);
        res.status(500).json({ error: '批量上链失败', details: error.message });
    }
});

// 🌟 删除气象数据（同时删除对应的区块链记录）
app.delete('/api/data/delete/:id', async (req, res) => {
    const { id } = req.params;
    try {
        // 1. 先删除关联的区块链记录（因外键约束）
        await pool.execute('DELETE FROM blockchain_records WHERE data_id = ?', [id]);
        // 2. 再删除气象数据本身
        await pool.execute('DELETE FROM meteorological_data WHERE id = ?', [id]);
        res.json({ success: true, message: '数据已成功删除' });
    } catch (error) {
        console.error('删除失败:', error);
        res.status(500).json({ error: '删除失败', details: error.message });
    }
});


// 启动服务器
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});