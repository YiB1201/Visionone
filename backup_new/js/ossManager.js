/**
 * ossManager.js - 统一 OSS 管理与 UI 交互核心
 */

// --- 全局状态 ---
let ossClient = null;
let ossConfig = {
    bucket: '',
    region: ''
};

// --- 1. 统一 UI 通知系统 ---
// 自动检测当前页面环境，选择最合适的提示方式
function notify(message, type = 'info', duration = 3000) {
    // 尝试使用 showCustomAlert (画廊页面)
    if (typeof window.showCustomAlert === 'function') {
        window.showCustomAlert(message, type, duration);
        return;
    }
    
    // 尝试使用 showErrorModal / showSuccessModal (上传页面)
    if (type === 'error' && typeof window.showErrorModal === 'function') {
        window.showErrorModal(message, '错误');
        return;
    }
    if (type === 'success' && typeof window.showSuccessModal === 'function') {
        // 上传页面的成功通常是模态框，这里不做自动调用，由业务层控制
        console.log('Success event triggered'); 
        return;
    }

    // 降级为原生 alert (管理页面或其他)
    if (type === 'error') {
        alert(`❌ ${message}`);
    } else if (type === 'success') {
        alert(`✅ ${message}`);
    } else {
        console.log(`ℹ️ ${message}`);
    }
}

// --- 2. 统一 OSS 初始化 ---
async function initOSS() {
    if (ossClient) return ossClient;

    try {
        // 显示加载状态（如果当前页面支持）
        if (typeof window.showCustomAlert === 'function') {
            window.showCustomAlert('正在连接 OSS...', 'loading', 0);
        }

        const creds = await getStsCredentials(); // 来自 utils.js
        
        const { accessKeyId, accessKeySecret, stsToken, region, bucket } = creds;
        ossConfig.bucket = bucket;
        ossConfig.region = region;

        ossClient = new OSS({
            region: region,
            bucket: bucket,
            accessKeyId: accessKeyId,
            accessKeySecret: accessKeySecret,
            stsToken: stsToken,
            refreshSTSToken: async () => {
                // 刷新逻辑
                const res = await fetch('https://oss-upload-sign-uhwltmbygx.cn-hangzhou.fcapp.run', { method: 'POST' });
                const d = await res.json();
                sessionStorage.setItem('oss_sts_credentials_v1', JSON.stringify(d));
                return {
                    accessKeyId: d.accessKeyId,
                    accessKeySecret: d.accessKeySecret,
                    stsToken: d.stsToken
                };
            }
        });

        if (typeof window.hideCustomAlert === 'function') window.hideCustomAlert();
        console.log('OSS Client Initialized');
        return ossClient;

    } catch (err) {
        console.error(err);
        notify(`OSS 初始化失败: ${err.message}`, 'error');
        if (typeof window.hideCustomAlert === 'function') window.hideCustomAlert();
        throw err;
    }
}

// --- 3. 通用业务函数 ---

// 获取哈希
async function getHash(message) {
    if (!message) return '';
    const msgBuffer = new TextEncoder().encode(message);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// 更新元数据索引 (通用)
async function updateMetadataIndex(objectKey, title, author, passwordHash) {
    const client = await initOSS();
    let indexFile = objectKey.startsWith('videos/') ? 'videos/index.json' : 'images/index.json';
    
    let metadataList = [];
    try {
        const result = await client.get(indexFile);
        const content = new TextDecoder("utf-8").decode(result.content);
        metadataList = JSON.parse(content);
        if (!Array.isArray(metadataList)) metadataList = [];
    } catch (e) {
        metadataList = [];
    }

    const existingIndex = metadataList.findIndex(item => item.key === objectKey);
    const newItem = { 
        key: objectKey, 
        title: title, 
        author: author, 
        password: passwordHash || '', 
        likes: existingIndex >= 0 ? (metadataList[existingIndex].likes || 0) : 0, 
        updateTime: Date.now() 
    };
    
    if (existingIndex >= 0) {
        metadataList[existingIndex] = newItem;
    } else {
        metadataList.push(newItem);
    }

    const blob = new Blob([JSON.stringify(metadataList, null, 2)], { type: 'application/json' });
    await client.put(indexFile, blob);
    console.log(`Metadata updated: ${indexFile}`);
}

// 删除文件并更新索引 (通用)
// ossmanager.js

// ... 其他代码 ...

// 删除文件并更新索引 (通用)
async function deleteMediaFile(fileName) {
    // 确保 client 已初始化
    const client = await initOSS();
    
    if (!client || typeof client.delete !== 'function') {
        console.error('OSS Client not initialized correctly or delete method missing');
        throw new Error('OSS 客户端初始化异常，无法执行删除操作');
    }

    try {
        // 1. 删除物理文件
        // ali-oss 的 delete 方法签名: delete(name, options)
        await client.delete(fileName);
        console.log(`File deleted: ${fileName}`);
        
    } catch (err) {
        console.error('Delete file error:', err);
        throw err; // 向上抛出错误，让调用者处理
    }
    
    // 2. 更新索引
    let indexFile = fileName.startsWith('videos/') ? 'videos/index.json' : 'images/index.json';
    let metaList = [];
    try {
        const res = await client.get(indexFile);
        const content = new TextDecoder("utf-8").decode(res.content);
        metaList = JSON.parse(content);
    } catch (e) { 
        console.warn('Index read failed during delete', e); 
        // 如果索引读取失败，可能文件本身也没了，或者网络问题，这里选择继续尝试更新本地缓存
    }

    const newList = metaList.filter(item => item.key !== fileName);
    const blob = new Blob([JSON.stringify(newList, null, 2)], { type: 'application/json' });
    
    try {
        await client.put(indexFile, blob);
        console.log(`Index updated: ${indexFile}`);
    } catch (err) {
        console.error('Update index error:', err);
        throw new Error('文件已删除，但索引更新失败: ' + err.message);
    }

    // 3. 清除本地缓存
    const LOCAL_META_KEY = 'oss_gallery_metadata_v1';
    try {
        let localMeta = JSON.parse(localStorage.getItem(LOCAL_META_KEY) || '[]');
        localMeta = localMeta.filter(item => item.key !== fileName);
        localStorage.setItem(LOCAL_META_KEY, JSON.stringify(localMeta));
    } catch (e) {
        console.warn('Local cache clear failed', e);
    }

    return true;
}

// ... 其他代码 ...

// 导出供其他文件使用
window.ossManager = {
    getClient: () => ossClient,
    init: initOSS,
    notify: notify,
    hash: getHash,
    updateMeta: updateMetadataIndex,
    delete: deleteMediaFile,
    config: ossConfig
};