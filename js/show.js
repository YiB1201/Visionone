// shows.js
let client = null;
let galleryViewer = null;

// STS 签名接口地址
const STS_API_URL = 'https://oss-upload-sign-uhwltmbygx.cn-hangzhou.fcapp.run';
// 【新增】本地缓存 Key
const LOCAL_META_KEY = 'oss_gallery_metadata_v1';
const LOCAL_LIKED_KEY = 'oss_gallery_liked_items_v1';

// 刷新限制变量
let lastRefreshTime = 0;
const REFRESH_LIMIT_INTERVAL = 20 * 1000; 
let likeSyncQueue = {}; 
let syncTimer = null;
const SYNC_DELAY = 3500; 

// 【新增】懒加载/无限滚动相关变量
let allMediaFiles = []; // 存储所有图片文件列表
let currentMetadataMap = {}; // 存储元数据映射
let loadedCount = 0; // 当前已渲染的数量
const PAGE_SIZE = 11; // 每次加载的图片数量
let isLoadingMore = false; // 防止重复加载
let isAllLoaded = false; // 是否全部加载完毕

// 1. 初始化 OSS Client
async function initOSS() {
    if (client) return true; 
    
    try {
        showCustomAlert('正在获取授权...', 'info', 0); 
        
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
        hideCustomAlert(); 
        return true;
    } catch (err) {
        console.error(err);
        showCustomAlert(`初始化失败: ${err.message}`, 'error');
        return false;
    }
}

// 【新增】获取本地已点赞列表
function getLikedItems() {
    try {
        const liked = localStorage.getItem(LOCAL_LIKED_KEY);
        return liked ? JSON.parse(liked) : [];
    } catch (e) {
        console.warn('解析已点赞列表失败', e);
        return [];
    }
}

// 【新增】保存本地已点赞列表
function saveLikedItems(likedList) {
    try {
        localStorage.setItem(LOCAL_LIKED_KEY, JSON.stringify(likedList));
    } catch (e) {
        console.warn('保存已点赞列表失败', e);
    }
}

// 【新增】检查是否已点赞
function isLiked(fileName) {
    const likedList = getLikedItems();
    return likedList.includes(fileName);
}

// 【新增】添加点赞记录
function addLikeRecord(fileName) {
    const likedList = getLikedItems();
    if (!likedList.includes(fileName)) {
        likedList.push(fileName);
        saveLikedItems(likedList);
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
function showCustomAlert(message, type = 'info', duration = 2000) {
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

// 【核心修改】loadImages：获取数据并初始化懒加载状态
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

    // 【重置懒加载状态】
    allMediaFiles = [];
    currentMetadataMap = {};
    loadedCount = 0;
    isAllLoaded = false;
    isLoadingMore = false;
    gallery.innerHTML = ''; // 清空现有画廊
    window.removeEventListener('scroll', handleScroll);
    
    const initialized = await initOSS();
    if (!initialized) {
        btn.disabled = false;
        btn.innerText = '🔄 重试';
        return;
    }

    showCustomAlert('正在加载数据...', 'loading', 0);

    try {
        // 【仅获取图片列表】
        let imageFiles = [];
        try {
            const imgResult = await client.list({ prefix: 'images/', 'max-keys': 1000 });
            const imgObjects = imgResult.value ? imgResult.value.objects : imgResult.objects;
            if (imgObjects) {
                imageFiles = imgObjects.filter(obj => !obj.name.endsWith('/') && obj.name !== 'images/index.json');
            }
        } catch (e) { console.warn('获取图片列表失败', e); }

        allMediaFiles = imageFiles; // 存入全局变量

        if (allMediaFiles.length === 0) {
            showCustomAlert('暂无媒体文件', 'info');
            btn.disabled = false;
            btn.innerText = '🔄 刷新列表';
            return;
        }

        // 获取元数据
        let localMetaList = getCachedMetadata();
        
        // 尝试从远程同步元数据
        try {
            let remoteMetaList = [];
            try {
                const metaImg = await client.get('images/index.json');
                const contentImg = new TextDecoder("utf-8").decode(metaImg.content);
                remoteMetaList = remoteMetaList.concat(JSON.parse(contentImg));
            } catch(e) { console.warn('无图片元数据'); }

            // 视频元数据获取已移除

            remoteMetaList.forEach(item => {
                if (item.likes === undefined) item.likes = 0;
            });

            saveCachedMetadata(remoteMetaList);
            localMetaList = remoteMetaList; 
        } catch (e) {
            console.warn('OSS 元数据同步完全失败，使用本地缓存', e);
        }

        // 构建元数据映射
        if (localMetaList) {
            localMetaList.forEach(item => {
                currentMetadataMap[item.key] = item;
            });
        }

        showCustomAlert('加载完成', 'success'); 
        initViewerJS();
        
        // 【关键】开始渲染第一页
        renderNextPage();
        
        // 绑定滚动事件监听器
        window.addEventListener('scroll', handleScroll);

    } catch (err) {
        console.error(err);
        showCustomAlert(`加载失败: ${err.message}`, 'error');
    } finally {
        btn.disabled = false;
        btn.innerText = '🔄 刷新列表';
    }
}

function initViewerJS() {
    if (galleryViewer) {
        // 如果已经存在，销毁旧实例以重新绑定（或者直接使用 update，但首次加载建议新建）
        galleryViewer.destroy();
    }
    
    const gallery = document.getElementById('gallery');
    
    galleryViewer = new Viewer(gallery, {
        inline: false, // 不以_inline_模式显示，而是模态框
        button: false,  // 显示右上角关闭按钮
        navbar: false,  // 显示底部导航栏（缩略图、比例等）
        title: true,   // 显示标题
        toolbar: true, // 显示工具栏（放大、缩小、旋转等）
        tooltip: true, // 显示缩放比例提示
        movable: true, // 可移动
        zoomable: true,// 【核心】可缩放
        rotatable: false,// 可旋转
        scalable: false,// 可翻转
        transition: true,// 开启过渡动画
        fullscreen: true,// 支持全屏
        keyboard: false, // 支持键盘操作
        
        // 当图片查看器打开时，禁止背景滚动
        show() {
            document.body.style.overflow = 'hidden';
        },
        // 当图片查看器关闭时，恢复背景滚动
        hidden() {
            document.body.style.overflow = '';
        }
    });
}

// 【新增】渲染下一页数据
function renderNextPage() {
    if (isLoadingMore || isAllLoaded) return;
    
    isLoadingMore = true;
    
    const startIndex = loadedCount;
    const endIndex = Math.min(startIndex + PAGE_SIZE, allMediaFiles.length);
    
    if (startIndex >= allMediaFiles.length) {
        isAllLoaded = true;
        isLoadingMore = false;
        return;
    }

    const filesToRender = allMediaFiles.slice(startIndex, endIndex);
    
    // 调用追加渲染函数
    appendGallery(filesToRender, currentMetadataMap);
    
    loadedCount = endIndex;
    
    if (loadedCount >= allMediaFiles.length) {
        isAllLoaded = true;
    }
    
    isLoadingMore = false;
    
    // 重新初始化 zoom，确保新加载的图片也能点击放大
    setTimeout(() => {
        if (galleryViewer) {
            galleryViewer.update();
        }
    }, 100);
}

// 【新增】滚动监听处理函数
function handleScroll() {
    if (isAllLoaded || isLoadingMore) return;

    const scrollTop = window.scrollY || document.documentElement.scrollTop;
    const windowHeight = window.innerHeight;
    const documentHeight = document.documentElement.scrollHeight;

    // 当距离底部小于 200px 时，加载下一页
    if (scrollTop + windowHeight >= documentHeight - 200) {
        renderNextPage();
    }
}

// 【修改】原 renderGallery 改为 appendGallery，支持追加渲染
function appendGallery(files, metadataMap={}) {
    const gallery = document.getElementById('gallery');
    const fragment = document.createDocumentFragment();
    const currentLikedItems = getLikedItems();

    files.forEach(file => {
        const card = document.createElement('div');
        card.className = 'image-card';
        card.style.cursor = 'pointer';
        card.style.position = 'relative'; 

        const fileUrl = `https://${window.ossBucket}.${window.ossRegion}.aliyuncs.com/${file.name}`;
        
        const meta = metadataMap[file.name] || {};
        const title = meta.title || file.name.split('/').pop(); 
        const author = meta.author || '未知作者';
        const likes = meta.likes || 0;

        const likeClass = currentLikedItems.includes(file.name) ? 'liked' : '';

        // 【移除视频相关 HTML】仅保留图片 HTML
        const mediaHtml = `
            <div class="img-wrapper">
                <img src="${fileUrl}" alt="${title}" loading="lazy" data-title="${title}">
            </div>
        `;

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
                    🖼️ ${title}
                </div>
                <div class="file-author" style="font-size: 0.85rem; color: #888; display:flex; justify-content:space-between; align-items:center;">
                    <span>👤 ${author}</span>
                    <span class="like-btn ${likeClass}" onclick="handleLike('${file.name}', this)" style="user-select:none;">
                        ❤️ <span class="like-count">${likes}</span>
                    </span>
                </div>
            </div>
        `;
        fragment.appendChild(card);
    });

    // 【关键】使用 appendChild 而不是 innerHTML = ''，实现追加效果
    gallery.appendChild(fragment);
}

// ... openVideoInNewWindow 函数已移除，因为不再需要 ...

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

// hashString 辅助函数，如果 utils.js 中没有，需要在这里定义
async function hashString(message) {
    const msgBuffer = new TextEncoder().encode(message);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return hashHex;
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

        // 【移除视频索引判断】只处理图片索引
        let indexFile = 'images/index.json';
        
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
        
        // 【关键修改】重置刷新计时器，并直接重新加载数据
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
    if (isLiked(fileName)) {
        showCustomAlert('您已经点赞过该作品了', 'info');
        return;
    }

    const countSpan = btnElement.querySelector('.like-count');
    let currentLikes = parseInt(countSpan.innerText) || 0;
    
    countSpan.innerText = currentLikes + 1;
    btnElement.classList.add('liked');
    addLikeRecord(fileName);

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
        
        // 【移除视频点赞同步】只同步图片
        const imageLikes = {};
        for (const [fileName, increment] of Object.entries(likeSyncQueue)) {
            imageLikes[fileName] = increment;
        }
        
        if (Object.keys(imageLikes).length > 0) {
            await syncLikesToIndex('images/index.json', imageLikes);
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

window.addEventListener('DOMContentLoaded', () => {
    loadImages();
});