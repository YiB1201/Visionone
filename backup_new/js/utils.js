/**
 * utils.js - 基础工具
 */
async function getStsCredentials() {
    const STORAGE_KEY = 'oss_sts_credentials_v1';
    try {
        const cached = sessionStorage.getItem(STORAGE_KEY);
        if (cached) {
            const data = JSON.parse(cached);
            if (data.expiration && new Date(data.expiration) > new Date()) {
                return data;
            }
        }
    } catch (e) { console.warn('Cache parse error', e); }

    console.log('Fetching new STS...');
    const STS_API_URL = 'https://oss-upload-sign-uhwltmbygx.cn-hangzhou.fcapp.run';
    const response = await fetch(STS_API_URL, { method: 'POST' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    
    const data = await response.json();
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    return data;
}