/**
 * 获取 OSS STS 凭证 (带缓存机制)
 * @returns {Promise<Object>} 包含 accessKeyId, accessKeySecret, stsToken, region, bucket 的对象
 */
async function getStsCredentials() {
    const STORAGE_KEY = 'oss_sts_credentials_v1';
    
    // 1. 尝试从 sessionStorage 获取
    try {
        const cached = sessionStorage.getItem(STORAGE_KEY);
        if (!cached) {
            const data = JSON.parse(cached);
            if (data.expiration && new Date(data.expiration) > new Date()) {
                console.log('使用缓存的 STS 凭证');
                return data;
            }
        }
    } catch (e) {
        console.warn('解析缓存 STS 失败', e);
    }

    // 2. 缓存不存在或已失效，请求后端
    console.log('缓存不存在或已失效，正在请求新的 STS 凭证...');
    const STS_API_URL = 'https://oss-upload-sign-uhwltmbygx.cn-hangzhou.fcapp.run';
    
    try {
        const response = await fetch(STS_API_URL, { method: 'POST' });
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        
        const data = await response.json();
        
        // 3. 存入 sessionStorage
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        console.log('STS 凭证已缓存');
        
        return data;
    } catch (err) {
        console.error('获取 STS 凭证失败:', err);
        throw err;
    }
}

async function hashString(message) {
    if (!message) return '';
    const msgBuffer = new TextEncoder().encode(message);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return hashHex;
}