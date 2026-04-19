// shows.js
let client = null;

// STS 签名接口地址
const STS_API_URL = 'https://oss-upload-sign-uhwltmbygx.cn-hangzhou.fcapp.run';
// 【新增】本地缓存 Key
const LOCAL_META_KEY = 'oss_gallery_metadata_v1';

// 刷新限制变量
let lastRefreshTime = 0;
const REFRESH_LIMIT_INTERVAL = 20 * 1000; 
let likeSyncQueue = {}; 
let syncTimer = null;
const SYNC_DELAY = 5000; 

// 1. 初始化 OSS Client
async function initOSS() {
    if (client) return true; 
    
    try {
        showCustomAlert('正在获取授权...', 'info', 0); // 使用弹窗提示
        
        const creds = await getStsCredentials();
        const { accessKeyId, accessKeySecret, stsToken, region, bucket } = creds;
        
        window.ossBucket = bucket; 
        window.ossRegion = region;

        client = new OSS({
            region: region,
            bucket: bucket,
            accessKeyId: accessKeyId,
            accessKeySecret: accessKeySecret,
            stsToken: stsToken,
            refreshSTSToken: async () => {
                const res = await fetch(STS_API_URL, { method: 'POST' });
                const d = await res.json();
                sessionStorage.setItem('oss_sts_credentials_v1', JSON.stringify(d));
                return {
                    accessKeyId: d.accessKeyId,
                    accessKeySecret: d.accessKeySecret,
                    stsToken: d.stsToken
                };
            }
        });
        
        console.log('OSS 初始化成功');
        hideCustomAlert(); // 隐藏加载提示
        return true;
    } catch (err) {
        console.error(err);
        showCustomAlert(`初始化失败: ${err.message}`, 'error');
        return false;
    }
}

function getCachedMetadata() {
    try {
        const cached = localStorage.getItem(LOCAL_META_KEY);
        if (cached) {
            const parsed = JSON.parse(cached);
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

// 【新增】通用自定义弹窗/提示函数
// type: 'info' | 'success' | 'error' | 'loading'
// duration: 自动关闭时间(ms), 0 表示不自动关闭
function showCustomAlert(message, type = 'info', duration = 3000) {
    let modal = document.getElementById('customAlertModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'customAlertModal';
        modal.className = 'custom-alert-overlay';
        document.body.appendChild(modal);
    }

    let icon = '';
    if (type === 'success') icon = '✅ ';
    if (type === 'error') icon = '❌ ';
    if (type === 'loading') icon = '<div class="spinner-small"></div> ';

    modal.innerHTML = `
        <div class="custom-alert-box ${type}">
            <div class="alert-content">${icon}${message}</div>
        </div>
    `;
    
    modal.style.display = 'flex';

    // 清除之前的定时器
    if (modal.timer) clearTimeout(modal.timer);

    if (duration > 0) {
        modal.timer = setTimeout(() => {
            hideCustomAlert();
        }, duration);
    }
}

function hideCustomAlert() {
    const modal = document.getElementById('customAlertModal');
    if (modal) {
        modal.style.display = 'none';
    }
}

// ... loadImages 函数保持不变，但内部提示改为弹窗 ...
async function loadImages() {
    const btn = document.getElementById('refreshBtn');
    
    const now = Date.now();
    if (now - lastRefreshTime < REFRESH_LIMIT_INTERVAL) {
        const remainingSeconds = Math.ceil((REFRESH_LIMIT_INTERVAL - (now - lastRefreshTime)) / 1000);
        showCustomAlert(`⚠️ 刷新太频繁，请等待 ${remainingSeconds} 秒`, 'error');
        return;
    }
    lastRefreshTime = now;

    const gallery = document.getElementById('gallery');
    btn.disabled = true;
    btn.innerText = '加载中...';
    
    // 初始化时已经显示了 loading 弹窗，这里不需要重复显示
    
    const initialized = await initOSS();
    if (!initialized) {
        btn.disabled = false;
        btn.innerText = '🔄 重试';
        return;
    }

    showCustomAlert('正在加载数据...', 'loading', 0);

    try {
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
                videoFiles = vidObjects.filter(obj => !obj.name.endsWith('/') && obj.name.toLowerCase().endsWith('.m3u8'));
            }
        } catch (e) { console.warn('获取视频列表失败', e); }

        const allMediaFiles = [...imageFiles, ...videoFiles];

        if (allMediaFiles.length === 0) {
            showCustomAlert('暂无媒体文件', 'info');
            btn.disabled = false;
            btn.innerText = '🔄 刷新列表';
            gallery.innerHTML = '';
            return;
        }

        let localMetaList = getCachedMetadata();
        let metadataMap = {};
        
        if (localMetaList) {
            localMetaList.forEach(item => {
                metadataMap[item.key] = item;
            });
            renderGallery(allMediaFiles, metadataMap);
            showCustomAlert('已加载缓存，正在检查更新...', 'info', 1500);
        } else {
            showCustomAlert('正在获取元数据...', 'loading', 0);
        }

        try {
            let remoteMetaList = [];
            try {
                const metaImg = await client.get('images/index.json');
                const contentImg = new TextDecoder("utf-8").decode(metaImg.content);
                remoteMetaList = remoteMetaList.concat(JSON.parse(contentImg));
            } catch(e) { console.warn('无图片元数据'); }

            try {
                const metaVid = await client.get('videos/index.json');
                const contentVid = new TextDecoder("utf-8").decode(metaVid.content);
                remoteMetaList = remoteMetaList.concat(JSON.parse(contentVid));
            } catch(e) { console.warn('无视频元数据'); }

            remoteMetaList.forEach(item => {
                if (item.likes === undefined) item.likes = 0;
            });

            saveCachedMetadata(remoteMetaList);
            
            metadataMap = {};
            remoteMetaList.forEach(item => {
                metadataMap[item.key] = item;
            });

            console.log('元数据已从 OSS 同步');
            renderGallery(allMediaFiles, metadataMap);
            showCustomAlert('加载完成', 'success'); 

        } catch (e) {
            console.warn('OSS 元数据同步完全失败', e);
            if (!localMetaList) {
                showCustomAlert('无法获取元数据，仅显示文件名', 'error');
            }
        }
        
        setTimeout(() => {
            if (typeof mediumZoom === 'function') {
                mediumZoom('.gallery-grid img', {
                    background: 'rgba(0, 0, 0, 0.9)',
                    margin: 24,
                    scrollOffset: 0,
                });
            }
        }, 100);

    } catch (err) {
        console.error(err);
        showCustomAlert(`加载失败: ${err.message}`, 'error');
    } finally {
        btn.disabled = false;
        btn.innerText = '🔄 刷新列表';
    }
}

function openVideoInNewWindow(videoUrl, title) {
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
    const win = window.open('', '_blank');
    if (win) {
        win.document.write(playerHtml);
        win.document.close();
    } else {
        showCustomAlert('请允许弹出窗口以播放视频', 'error');
    }
}

function renderGallery(files, metadataMap={}) {
    const gallery = document.getElementById('gallery');
    const fragment = document.createDocumentFragment();

    files.forEach(file => {
        const card = document.createElement('div');
        card.className = 'image-card';
        card.style.cursor = 'pointer';
        card.style.position = 'relative'; 

        const fileUrl = `https://${window.ossBucket}.${window.ossRegion}.aliyuncs.com/${file.name}`;
        const isVideo = file.name.toLowerCase().endsWith('.m3u8');
        
        const meta = metadataMap[file.name] || {};
        const title = meta.title || file.name.split('/').pop(); 
        const author = meta.author || '未知作者';
        const likes = meta.likes || 0;

        let mediaHtml = '';
        
        if (isVideo) {
            const playIconUrl = 'https://img.icons8.com/ios-filled/100/ffffff/play.png'; 
            mediaHtml = `
                <div class="img-wrapper video-cover-wrapper" style="background-color: #000; display: flex; justify-content: center; align-items: center;">
                    <img src="${playIconUrl}" style="width: 60px; height: 60px; opacity: 0.8; pointer-events: none;" alt="Play">
                    <div style="position:absolute; bottom:10px; right:10px; background:rgba(0,0,0,0.6); color:white; padding:2px 6px; border-radius:4px; font-size:12px;">VIDEO</div>
                </div>
            `;
            card.onclick = (e) => {
                if (e.target.closest('.like-btn') || e.target.closest('.card-menu-btn')) return;
                openVideoInNewWindow(fileUrl, title);
            };
        } else {
            mediaHtml = `
                <div class="img-wrapper">
                    <img src="${fileUrl}" alt="${title}" loading="lazy">
                </div>
            `;
        }

        const menuHtml = `
            <div class="card-menu-container">
                <button class="card-menu-btn" onclick="toggleMenu(event, '${file.name}')">⋮</button>
                <div id="menu-${file.name.replace(/[^a-zA-Z0-9]/g, '_')}" class="card-dropdown-menu">
                    <div class="menu-item delete-item" onclick="promptDelete('${file.name}', '${meta.password || ''}')">
                        🗑️ 删除
                    </div>
                </div>
            </div>
        `;

        card.innerHTML = `
            ${mediaHtml}
            ${menuHtml}
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

window.toggleMenu = function(event, fileName) {
    event.stopPropagation(); 
    const safeId = fileName.replace(/[^a-zA-Z0-9]/g, '_');
    const menu = document.getElementById(`menu-${safeId}`);
    
    document.querySelectorAll('.card-dropdown-menu').forEach(m => {
        if (m.id !== `menu-${safeId}`) m.classList.remove('show');
    });

    if (menu) {
        menu.classList.toggle('show');
    }
};

document.addEventListener('click', () => {
    document.querySelectorAll('.card-dropdown-menu').forEach(m => m.classList.remove('show'));
});

// 【修改】使用自定义确认弹窗替代 confirm
function showConfirmDialog(message, onConfirm) {
    const modal = document.createElement('div');
    modal.className = 'custom-alert-overlay';
    modal.innerHTML = `
        <div class="custom-alert-box confirm-box">
            <div class="alert-content">${message}</div>
            <div class="confirm-actions">
                <button class="btn-cancel">取消</button>
                <button class="btn-confirm">确定</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    modal.style.display = 'flex';

    const btnCancel = modal.querySelector('.btn-cancel');
    const btnConfirm = modal.querySelector('.btn-confirm');

    const close = () => {
        document.body.removeChild(modal);
    };

    btnCancel.onclick = close;
    btnConfirm.onclick = () => {
        close();
        if (onConfirm) onConfirm();
    };
}

window.promptDelete = async function(fileName, storedHashedPassword) {
    document.querySelectorAll('.card-dropdown-menu').forEach(m => m.classList.remove('show'));

    if (!storedHashedPassword) {
        showConfirmDialog('该文件没有设置删除密码，确定要删除吗？', () => {
            executeDelete(fileName);
        });
        return;
    }

    const modal = document.createElement('div');
    modal.className = 'delete-modal-overlay';
    modal.innerHTML = `
        <div class="delete-modal">
            <h3>🔒 验证删除密码</h3>
            <p>请输入上传时设置的密码以删除此文件</p>
            <input type="password" id="deleteInputPwd" placeholder="请输入密码" />
            <div class="delete-modal-actions">
                <button class="btn-cancel" onclick="this.closest('.delete-modal-overlay').remove()">取消</button>
                <button class="btn-confirm" id="btnConfirmDelete">确认删除</button>
            </div>
            <div id="deleteErrorMsg" style="color:red; font-size:0.8rem; margin-top:5px; display:none;"></div>
        </div>
    `;
    document.body.appendChild(modal);
    modal.style.display = 'flex';

    const input = modal.querySelector('#deleteInputPwd');
    const confirmBtn = modal.querySelector('#btnConfirmDelete');
    const errorMsg = modal.querySelector('#deleteErrorMsg');

    input.focus();

    const handleConfirm = async () => {
        const userInput = input.value.trim();
        if (!userInput) {
            errorMsg.innerText = '密码不能为空';
            errorMsg.style.display = 'block';
            return;
        }

        confirmBtn.disabled = true;
        confirmBtn.innerText = '验证中...';

        try {
            const inputHash = await hashString(userInput);
            
            if (inputHash === storedHashedPassword) {
                modal.remove();
                executeDelete(fileName);
            } else {
                errorMsg.innerText = '密码错误，请重试';
                errorMsg.style.display = 'block';
                input.value = '';
                input.focus();
            }
        } catch (e) {
            errorMsg.innerText = '验证出错: ' + e.message;
            errorMsg.style.display = 'block';
        } finally {
            confirmBtn.disabled = false;
            confirmBtn.innerText = '确认删除';
        }
    };

    confirmBtn.onclick = handleConfirm;
    
    input.onkeydown = (e) => {
        if (e.key === 'Enter') handleConfirm();
    };
};

// 【修改】执行删除后强制刷新，绕过限制
async function executeDelete(fileName) {
    showCustomAlert('正在删除文件...', 'loading', 0);
    try {
        if (!client) await initOSS();
        
        await client.delete(fileName);
        console.log(`Deleted OSS file: ${fileName}`);

        let indexFile = fileName.startsWith('videos/') ? 'videos/index.json' : 'images/index.json';
        
        let metaList = [];
        try {
            const res = await client.get(indexFile);
            const content = new TextDecoder("utf-8").decode(res.content);
            metaList = JSON.parse(content);
        } catch (e) {
            console.warn('读取索引失败', e);
        }

        const newList = metaList.filter(item => item.key !== fileName);
        
        const blob = new Blob([JSON.stringify(newList, null, 2)], { type: 'application/json' });
        await client.put(indexFile, blob);

        let localMeta = getCachedMetadata() || [];
        localMeta = localMeta.filter(item => item.key !== fileName);
        saveCachedMetadata(localMeta);

        showCustomAlert('✅ 删除成功', 'success');
        
        // 【关键修改】重置刷新计时器，并直接重新加载数据，不再受 20s 限制
        lastRefreshTime = 0; 
        
        // 延迟一点让用户看到成功提示，然后刷新
        setTimeout(() => {
            loadImages();
        }, 1000);

    } catch (err) {
        console.error(err);
        showCustomAlert(`❌ 删除失败: ${err.message}`, 'error');
    }
}

async function handleLike(fileName, btnElement) {
    const countSpan = btnElement.querySelector('.like-count');
    let currentLikes = parseInt(countSpan.innerText) || 0;
    
    countSpan.innerText = currentLikes + 1;
    
    let localMetaList = getCachedMetadata() || [];
    let targetItem = localMetaList.find(item => item.key === fileName);
    
    if (targetItem) {
        targetItem.likes = (targetItem.likes || 0) + 1;
    } else {
        targetItem = { key: fileName, likes: 1, title: '', author: '' };
        localMetaList.push(targetItem);
    }
    saveCachedMetadata(localMetaList);

    if (!likeSyncQueue[fileName]) {
        likeSyncQueue[fileName] = 0;
    }
    likeSyncQueue[fileName]++;

    if (syncTimer) clearTimeout(syncTimer);
    
    syncTimer = setTimeout(async () => {
        await flushLikeSync(); 
    }, SYNC_DELAY);
}

async function flushLikeSync() {
    if (Object.keys(likeSyncQueue).length === 0) return;
    try {
        if (!client) await initOSS();
        const imageLikes = {};
        const videoLikes = {};
        for (const [fileName, increment] of Object.entries(likeSyncQueue)) {
            if (fileName.toLowerCase().endsWith('.m3u8')) {
                videoLikes[fileName] = increment;
            } else {
                imageLikes[fileName] = increment;
            }
        }
        if (Object.keys(imageLikes).length > 0) {
            await syncLikesToIndex('images/index.json', imageLikes);
        }
        if (Object.keys(videoLikes).length > 0) {
            await syncLikesToIndex('videos/index.json', videoLikes);
        }
        likeSyncQueue = {};
        console.log('所有点赞同步成功');
    } catch (err) {
        console.error('批量点赞同步失败:', err);
        showCustomAlert('点赞同步失败，数据已保存在本地', 'error');
    }
}

async function syncLikesToIndex(indexFilePath, likesMap) {
    let remoteMetaList = [];
    try {
        const result = await client.get(indexFilePath);
        const content = new TextDecoder("utf-8").decode(result.content);
        remoteMetaList = JSON.parse(content);
        if (!Array.isArray(remoteMetaList)) remoteMetaList = [];
    } catch (e) {
        console.warn(`${indexFilePath} 不存在或解析失败，将创建新文件`, e);
        remoteMetaList = [];
    }
    let hasChanges = false;
    for (const [fileName, increment] of Object.entries(likesMap)) {
        const remoteIndex = remoteMetaList.findIndex(item => item.key === fileName);
        if (remoteIndex !== -1) {
            remoteMetaList[remoteIndex].likes = (remoteMetaList[remoteIndex].likes || 0) + increment;
            hasChanges = true;
        } else {
            console.warn(`在 ${indexFilePath} 中未找到 ${fileName}，创建新记录`);
            remoteMetaList.push({
                key: fileName,
                title: fileName.split('/').pop(),
                author: '未知作者',
                likes: increment,
                updateTime: Date.now()
            });
            hasChanges = true;
        }
    }
    if (hasChanges) {
        const jsonStr = JSON.stringify(remoteMetaList, null, 2);
        const blob = new Blob([jsonStr], { type: 'application/json' });
        await client.put(indexFilePath, blob);
        console.log(`${indexFilePath} 同步成功`);
    }
}

// 移除旧的 showStatus 函数，统一使用 showCustomAlert

window.addEventListener('DOMContentLoaded', () => {
    loadImages();
});