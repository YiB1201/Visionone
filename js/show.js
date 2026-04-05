// shows.js
let client = null;
let bucket = '';
let region = '';

// STS 签名接口地址
const STS_API_URL = 'https://oss-upload-sign-uhwltmbygx.cn-hangzhou.fcapp.run';
// 【新增】本地缓存 Key
const LOCAL_META_KEY = 'oss_gallery_metadata_v1';

// 刷新限制变量
let lastRefreshTime = 0;
const REFRESH_LIMIT_INTERVAL = 20 * 1000; 
let likeSyncQueue = {}; // 存储待同步的点赞增量: { 'images/xxx.jpg': 3, 'images/yyy.png': 1 }
let syncTimer = null;
const SYNC_DELAY = 5000; // 停止点赞 2 秒后同步

// 1. 初始化 OSS Client
async function initOSS() {
    if (client) return true;
    try {
        document.getElementById('statusMsg').innerText = '正在获取授权...';
        const response = await fetch(STS_API_URL, { method: 'POST' });
        if (!response.ok) throw new Error('网络请求失败');
        
        const data = await response.json();
        const { accessKeyId, accessKeySecret, stsToken, region: r, bucket: b } = data;
        
        bucket = b;
        region = r;

        client = new OSS({
            region: r,
            bucket: b,
            accessKeyId: accessKeyId,
            accessKeySecret: accessKeySecret,
            stsToken: stsToken,
            refreshSTSToken: async () => {
                const res = await fetch(STS_API_URL, { method: 'POST' });
                const d = await res.json();
                return {
                    accessKeyId: d.accessKeyId,
                    accessKeySecret: d.accessKeySecret,
                    stsToken: d.stsToken
                };
            }
        });
        console.log('OSS 初始化成功');
        return true;
    } catch (err) {
        console.error(err);
        showStatus(`初始化失败: ${err.message}`, true);
        return false;
    }
}


function getCachedMetadata() {
    try {
        const cached = localStorage.getItem(LOCAL_META_KEY);
        if (cached) {
            const parsed = JSON.parse(cached);
            console.log('使用本地缓存元数据', parsed.length, '条');
            return parsed;
        }
    } catch (e) {
        console.warn('本地缓存解析失败', e);
    }
    return null;
}

function saveCachedMetadata(metaList) {
    try {
        localStorage.setItem(LOCAL_META_KEY, JSON.stringify(metaList));
    } catch (e) {
        console.warn('保存本地缓存失败', e);
    }
}


// show.js

// ... 前面的变量定义保持不变 ...

// 【修改】 loadImages 函数中的文件获取部分
async function loadImages() {
    const btn = document.getElementById('refreshBtn');
    
    // 检查刷新频率 (保持不变)
    const now = Date.now();
    if (now - lastRefreshTime < REFRESH_LIMIT_INTERVAL) {
        const remainingSeconds = Math.ceil((REFRESH_LIMIT_INTERVAL - (now - lastRefreshTime)) / 1000);
        showStatus(`⚠️ 刷新太频繁，请等待 ${remainingSeconds} 秒`, true);
        return;
    }
    lastRefreshTime = now;

    const gallery = document.getElementById('gallery');
    btn.disabled = true;
    btn.innerText = '加载中...';
    
    const initialized = await initOSS();
    if (!initialized) {
        btn.disabled = false;
        btn.innerText = '🔄 重试';
        return;
    }

    showStatus('正在加载数据...');

    try {
        // 【修改】 并行获取 images 和 videos 目录
        // 注意：如果某个目录不存在，list 可能会报错或返回空，这里做简单容错
        let imageFiles = [];
        let videoFiles = [];

        try {
            const imgResult = await client.list({ prefix: 'images/', 'max-keys': 1000 });
            const imgObjects = imgResult.value ? imgResult.value.objects : imgResult.objects;
            if (imgObjects) {
                imageFiles = imgObjects.filter(obj => !obj.name.endsWith('/') && obj.name !== 'images/index.json');
            }
        } catch (e) { console.warn('获取图片列表失败', e); }

        try {
            const vidResult = await client.list({ prefix: 'videos/', 'max-keys': 1000 });
            const vidObjects = vidResult.value ? vidResult.value.objects : vidResult.objects;
            if (vidObjects) {
                // 过滤出 .m3u8 文件作为主入口，也可以包含 .ts 但通常只需展示 .m3u8
                videoFiles = vidObjects.filter(obj => !obj.name.endsWith('/') && obj.name.toLowerCase().endsWith('.m3u8'));
            }
        } catch (e) { console.warn('获取视频列表失败', e); }

        // 合并所有媒体文件
        const allMediaFiles = [...imageFiles, ...videoFiles];

        if (allMediaFiles.length === 0) {
            showStatus('暂无媒体文件');
            btn.disabled = false;
            btn.innerText = '🔄 刷新列表';
            gallery.innerHTML = '';
            return;
        }

        // 2. 尝试从本地缓存加载元数据 (保持不变)
        let localMetaList = getCachedMetadata();
        let metadataMap = {};
        
        if (localMetaList) {
            localMetaList.forEach(item => {
                metadataMap[item.key] = item;
            });
            renderGallery(allMediaFiles, metadataMap);
            showStatus('已加载缓存，正在检查更新...');
        } else {
            showStatus('正在获取元数据...');
        }

        // 3. 同步远程元数据 (保持不变，但要注意 index.json 需要包含视频的元数据)
        try {
            // 假设 videos 也有一个 index.json 或者统一放在根目录/各自目录下？
            // 这里假设你仍然使用统一的 images/index.json 或者你需要创建 videos/index.json
            // 为了简化，我们尝试读取两个可能的元数据文件，或者你可以约定统一存储结构
            
            // 方案 A: 如果只有一个总的 index.json (例如在根目录或 images 下包含所有引用)
            // 方案 B (推荐): 分别读取。这里演示读取 images/index.json 和 videos/index.json 并合并
            
            let remoteMetaList = [];

            // 读取图片元数据
            try {
                const metaImg = await client.get('images/index.json');
                const contentImg = new TextDecoder("utf-8").decode(metaImg.content);
                remoteMetaList = remoteMetaList.concat(JSON.parse(contentImg));
            } catch(e) { console.warn('无图片元数据'); }

            // 读取视频元数据
            try {
                const metaVid = await client.get('videos/index.json');
                const contentVid = new TextDecoder("utf-8").decode(metaVid.content);
                remoteMetaList = remoteMetaList.concat(JSON.parse(contentVid));
            } catch(e) { console.warn('无视频元数据'); }

            // 确保 likes 字段
            remoteMetaList.forEach(item => {
                if (item.likes === undefined) item.likes = 0;
            });

            // 更新缓存 (合并保存)
            saveCachedMetadata(remoteMetaList);
            
            // 更新 Map
            metadataMap = {};
            remoteMetaList.forEach(item => {
                metadataMap[item.key] = item;
            });

            console.log('元数据已从 OSS 同步');
            renderGallery(allMediaFiles, metadataMap);
            showStatus(''); 

        } catch (e) {
            console.warn('OSS 元数据同步完全失败', e);
            if (!localMetaList) {
                showStatus('无法获取元数据，仅显示文件名');
            }
        }
        
        // 激活 zoom (只对图片生效)
        setTimeout(() => {
            if (typeof mediumZoom === 'function') {
                // 只选择 img 标签，排除 video
                mediumZoom('.gallery-grid img', {
                    background: 'rgba(0, 0, 0, 0.9)',
                    margin: 24,
                    scrollOffset: 0,
                });
            }
        }, 100);

    } catch (err) {
        console.error(err);
        showStatus(`加载失败: ${err.message}`, true);
    } finally {
        btn.disabled = false;
        btn.innerText = '🔄 刷新列表';
    }
}

// 【重写】 renderGallery 函数，支持视频和图片混合渲染
function openVideoInNewWindow(videoUrl, title) {
    // 创建一个简单的 HTML 字符串，包含 hls.js 播放器
    const playerHtml = `
        <!DOCTYPE html>
        <html lang="zh-CN">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>${title} - 播放</title>
            <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"><\/script>
            <style>
                body { margin: 0; padding: 0; background: #000; display: flex; justify-content: center; align-items: center; height: 100vh; overflow: hidden; }
                video { width: 100%; height: 100%; max-width: 100%; max-height: 100%; }
            </style>
        </head>
        <body>
            <video id="video" controls autoplay></video>
            <script>
                var video = document.getElementById('video');
                var videoSrc = '${videoUrl}';
                if (Hls.isSupported()) {
                    var hls = new Hls();
                    hls.loadSource(videoSrc);
                    hls.attachMedia(video);
                    hls.on(Hls.Events.MANIFEST_PARSED, function() {
                        video.play().catch(e => console.log("自动播放被拦截", e));
                    });
                } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
                    video.src = videoSrc;
                    video.addEventListener('loadedmetadata', function() {
                        video.play().catch(e => console.log("自动播放被拦截", e));
                    });
                }
            <\/script>
        </body>
        </html>
    `;

    // 打开新窗口
    const win = window.open('', '_blank');
    if (win) {
        win.document.write(playerHtml);
        win.document.close(); // 必须关闭文档流，否则浏览器会一直显示加载状态
    } else {
        alert('请允许弹出窗口以播放视频');
    }
}

// 【重写】 renderGallery 函数
function renderGallery(files, metadataMap={}) {
    const gallery = document.getElementById('gallery');
    const fragment = document.createDocumentFragment();

    files.forEach(file => {
        const card = document.createElement('div');
        card.className = 'image-card';
        
        // 添加指针样式，提示可点击
        card.style.cursor = 'pointer';

        const fileUrl = `https://${bucket}.${region}.aliyuncs.com/${file.name}`;
        const isVideo = file.name.toLowerCase().endsWith('.m3u8');
        
        const meta = metadataMap[file.name] || {};
        const title = meta.title || file.name.split('/').pop(); 
        const author = meta.author || '未知作者';
        const likes = meta.likes || 0;

        let mediaHtml = '';
        
        if (isVideo) {
            // 【修改】视频不再渲染 video 标签，而是渲染一个带播放图标的封面
            // 这里使用一个在线的通用播放图标，或者你可以本地放一个 play-icon.png
            const playIconUrl = 'https://img.icons8.com/ios-filled/100/ffffff/play.png'; 
            
            mediaHtml = `
                <div class="img-wrapper video-cover-wrapper" style="background-color: #000; display: flex; justify-content: center; align-items: center;">
                    <!-- 这里可以用一张真实的截图作为背景图，如果有的话。如果没有，就用黑色背景+图标 -->
                    <img src="${playIconUrl}" style="width: 60px; height: 60px; opacity: 0.8; pointer-events: none;" alt="Play">
                    <div style="position:absolute; bottom:10px; right:10px; background:rgba(0,0,0,0.6); color:white; padding:2px 6px; border-radius:4px; font-size:12px;">VIDEO</div>
                </div>
            `;
            
            // 视频卡片点击事件：打开新窗口
            card.onclick = (e) => {
                // 防止点击点赞按钮时触发卡片点击
                if (e.target.closest('.like-btn')) return;
                openVideoInNewWindow(fileUrl, title);
            };

        } else {
            // 图片保持原样
            mediaHtml = `
                <div class="img-wrapper">
                    <img src="${fileUrl}" alt="${title}" loading="lazy">
                </div>
            `;
            
            // 图片卡片点击事件：原本由 medium-zoom 处理，不需要额外 onclick
            // 但为了统一体验，如果希望点击图片也放大，medium-zoom 会自动处理 img 标签
        }

        card.innerHTML = `
            ${mediaHtml}
            <div class="file-info">
                <div class="file-name" style="font-weight: bold; font-size: 1rem; margin-bottom: 4px;" title="${title}">
                    ${isVideo ? '🎥 ' : '🖼️ '}${title}
                </div>
                <div class="file-author" style="font-size: 0.85rem; color: #888; display:flex; justify-content:space-between; align-items:center;">
                    <span>👤 ${author}</span>
                    <span class="like-btn" onclick="handleLike('${file.name}', this)" style="cursor:pointer; user-select:none;">
                        ❤️ <span class="like-count">${likes}</span>
                    </span>
                </div>
            </div>
        `;

        fragment.appendChild(card);
    });

    gallery.innerHTML = ''; 
    gallery.appendChild(fragment);

}

// 【优化】处理点赞逻辑
async function handleLike(fileName, btnElement) {
    const countSpan = btnElement.querySelector('.like-count');
    let currentLikes = parseInt(countSpan.innerText) || 0;
    
    // 1. 乐观更新 UI
    countSpan.innerText = currentLikes + 1;
    
    // 2. 更新本地缓存 (立即生效)
    let localMetaList = getCachedMetadata() || [];
    let targetItem = localMetaList.find(item => item.key === fileName);
    
    if (targetItem) {
        targetItem.likes = (targetItem.likes || 0) + 1;
    } else {
        // 极端情况：本地没有记录，创建一条
        targetItem = { key: fileName, likes: 1, title: '', author: '' };
        localMetaList.push(targetItem);
    }
    saveCachedMetadata(localMetaList);

    // 3. 加入同步队列
    if (!likeSyncQueue[fileName]) {
        likeSyncQueue[fileName] = 0;
    }
    likeSyncQueue[fileName]++;

    // 4. 重置防抖定时器
    if (syncTimer) clearTimeout(syncTimer);
    
    syncTimer = setTimeout(async () => {
        await flushLikeSync(); // 执行同步
    }, SYNC_DELAY);
}

// 【新增】批量同步点赞数据到 OSS
async function flushLikeSync() {
    // 如果队列为空，直接返回
    if (Object.keys(likeSyncQueue).length === 0) return;

    console.log('开始批量同步点赞数据...', likeSyncQueue);

    try {
        if (!client) await initOSS();

        // 1. 将队列中的文件按类型分组
        const imageLikes = {};
        const videoLikes = {};

        for (const [fileName, increment] of Object.entries(likeSyncQueue)) {
            if (fileName.toLowerCase().endsWith('.m3u8')) {
                videoLikes[fileName] = increment;
            } else {
                imageLikes[fileName] = increment;
            }
        }

        // 2. 处理图片点赞 (写入 images/index.json)
        if (Object.keys(imageLikes).length > 0) {
            await syncLikesToIndex('images/index.json', imageLikes);
        }

        // 3. 处理视频点赞 (写入 videos/index.json)
        if (Object.keys(videoLikes).length > 0) {
            await syncLikesToIndex('videos/index.json', videoLikes);
        }

        // 4. 全部成功后清空队列
        likeSyncQueue = {};
        console.log('所有点赞同步成功');

    } catch (err) {
        console.error('批量点赞同步失败:', err);
        alert('点赞同步失败，数据已保存在本地，下次打开页面时会尝试重新同步');
        // 注意：这里不清空 likeSyncQueue，以便下次重试
    }
}

// 【新增】辅助函数：同步特定类型的点赞到指定索引文件
async function syncLikesToIndex(indexFilePath, likesMap) {
    let remoteMetaList = [];
    
    // 1. 读取现有的索引文件
    try {
        const result = await client.get(indexFilePath);
        const content = new TextDecoder("utf-8").decode(result.content);
        remoteMetaList = JSON.parse(content);
        if (!Array.isArray(remoteMetaList)) remoteMetaList = [];
    } catch (e) {
        console.warn(`${indexFilePath} 不存在或解析失败，将创建新文件`, e);
        remoteMetaList = [];
    }

    // 2. 应用增量
    let hasChanges = false;
    for (const [fileName, increment] of Object.entries(likesMap)) {
        const remoteIndex = remoteMetaList.findIndex(item => item.key === fileName);
        
        if (remoteIndex !== -1) {
            // 如果存在，累加
            remoteMetaList[remoteIndex].likes = (remoteMetaList[remoteIndex].likes || 0) + increment;
            hasChanges = true;
        } else {
            // 如果不存在（可能是新上传但未刷新索引，或者元数据丢失），创建一条新记录
            console.warn(`在 ${indexFilePath} 中未找到 ${fileName}，创建新记录`);
            remoteMetaList.push({
                key: fileName,
                title: fileName.split('/').pop(), // 默认标题为文件名
                author: '未知作者',
                likes: increment,
                updateTime: Date.now()
            });
            hasChanges = true;
        }
    }

    // 3. 如果有变化，写回 OSS
    if (hasChanges) {
        const jsonStr = JSON.stringify(remoteMetaList, null, 2);
        const blob = new Blob([jsonStr], { type: 'application/json' });
        await client.put(indexFilePath, blob);
        console.log(`${indexFilePath} 同步成功`);
    }
}

function showStatus(msg, isError = false) {
    const el = document.getElementById('statusMsg');
    el.innerHTML = msg;
    el.className = isError ? 'error-tip' : 'loading-tip';
    if (!msg) el.style.display = 'none';
    else el.style.display = 'block';
}

window.addEventListener('DOMContentLoaded', () => {
    loadImages();
});