let client = null;
let regionHost = null;
let buckets = null;

// 【修改】将 DOM 元素获取放在一个初始化函数中，或者在使用前检查
let fileInput, fileNameDisplay, dropZone, titleInput, authorInput, passwordInput;
let autoRedirectTimer = null;
let countdownInterval = null;

// 【新增】初始化上传页面的 DOM 元素和事件
function initUploadPage() {
    // 只有在当前页面存在 fileInput 时才执行初始化，避免在 manager.html 或 shows.html 报错
    fileInput = document.getElementById('fileInput');
    if (!fileInput) return; 

    fileNameDisplay = document.getElementById('fileNameDisplay');
    dropZone = document.getElementById('dropZone');
    titleInput = document.getElementById('imageTitle');
    authorInput = document.getElementById('authorName');
    passwordInput = document.getElementById('deletePassword');

    fileInput.addEventListener('change', function () {
        if (this.files && this.files[0]) {
            fileNameDisplay.textContent = `已选择: ${this.files[0].name}`;
            fileNameDisplay.style.display = 'block';
        } else {
            fileNameDisplay.style.display = 'none';
        }
    });

    // 拖拽效果
    if (dropZone) {
        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropZone.classList.add('dragover');
        });

        dropZone.addEventListener('dragleave', () => {
            dropZone.classList.remove('dragover');
        });

        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropZone.classList.remove('dragover');
            if (e.dataTransfer.files.length) {
                fileInput.files = e.dataTransfer.files;
                fileNameDisplay.textContent = `已选择: ${e.dataTransfer.files[0].name}`;
                fileNameDisplay.style.display = 'block';
            }
        });
    }
    
    // 绑定错误弹窗关闭逻辑
    const errorModal = document.getElementById('errorModal');
    if (errorModal) {
        errorModal.addEventListener('click', (e) => {
            if (e.target === errorModal) {
                closeErrorModal();
            }
        });
    }
}

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', initUploadPage);

//获取 STS 签名并初始化 OSS Client
async function initOSSClient() {
    if (client) return; // 防止重复初始化

    try {
        // 使用统一的凭证获取函数
        const stsData = await getStsCredentials();
        
        const { region, bucket, accessKeyId, accessKeySecret, stsToken } = stsData;
        
        // 更新全局变量供上传使用
        regionHost = `${region}.aliyuncs.com`;
        buckets = bucket;

        client = new OSS({
            region: region,
            bucket: bucket,
            accessKeyId: accessKeyId,
            accessKeySecret: accessKeySecret,
            stsToken: stsToken,
            refreshSTSToken: async () => {
                // 刷新逻辑同上
                const STS_API_URL = 'https://oss-upload-sign-uhwltmbygx.cn-hangzhou.fcapp.run';
                const freshResponse = await fetch(STS_API_URL, { method: 'POST' });
                const freshData = await freshResponse.json();
                
                // 更新缓存
                sessionStorage.setItem('oss_sts_credentials_v1', JSON.stringify(freshData));

                return {
                    accessKeyId: freshData.accessKeyId,
                    accessKeySecret: freshData.accessKeySecret,
                    stsToken: freshData.stsToken
                };
            },
            refreshSTSTokenInterval: 300000 // 5分钟刷新一次
        });

        console.log('OSS Client 初始化成功 (使用缓存或新凭证)');
    } catch (err) {
        console.error('初始化 OSS 失败:', err);
        alert('初始化上传环境失败，请检查网络或后端服务');
        throw err;
    }
}

// upload.js 中的修改建议

// 修改函数签名，或者直接根据 objectKey 判断
async function updateMetadataIndex(objectKey, title, author, password) {
    // 【修改】根据文件路径决定索引文件位置
    let indexFile = 'images/index.json';
    if (objectKey.startsWith('videos/')) {
        indexFile = 'videos/index.json';
    }

    let metadataList = [];
    
    try {
        const result = await client.get(indexFile);
        const content = new TextDecoder("utf-8").decode(result.content);
        metadataList = JSON.parse(content);
        if (!Array.isArray(metadataList)) metadataList = [];
    } catch (e) {
        console.log(`${indexFile} 不存在，创建新索引`);
        metadataList = [];
    }

    const existingIndex = metadataList.findIndex(item => item.key === objectKey);
    
    // 【修改】将 password 加入 newItem
    const newItem = { 
        key: objectKey, 
        title: title, 
        author: author, 
        password: password, // 存储密码（注意：生产环境建议后端加密存储，前端直接存明文有风险，但作为简单Demo可行）
        likes: 0, 
        updateTime: Date.now() 
    };
    
    if (existingIndex >= 0) {
        newItem.likes = metadataList[existingIndex].likes || 0;
        // 如果更新时没传密码，保留旧密码？或者强制更新？这里假设每次上传都重置或更新
        if (!password) {
            newItem.password = metadataList[existingIndex].password;
        }
        metadataList[existingIndex] = newItem;
    } else {
        metadataList.push(newItem);
    }

    const jsonStr = JSON.stringify(metadataList, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    
    await client.put(indexFile, blob);
    console.log(`元数据索引 ${indexFile} 更新成功`);
}

// 【新增】显示成功弹窗
function showSuccessModal() {
    const modal = document.getElementById('successModal');
    const countdownEl = document.getElementById('countdownText');
    
    modal.style.display = 'flex';
    
    let seconds = 5;
    countdownEl.innerText = seconds;

    // 清除之前的定时器，防止冲突
    if (autoRedirectTimer) clearTimeout(autoRedirectTimer);
    if (countdownInterval) clearInterval(countdownInterval);

    // 倒计时逻辑
    countdownInterval = setInterval(() => {
        seconds--;
        countdownEl.innerText = seconds;
        if (seconds <= 0) {
            clearInterval(countdownInterval);
        }
    }, 1000);

    // 自动跳转逻辑
    autoRedirectTimer = setTimeout(() => {
        goToGallery();
    }, 5000);
}
// 【新增】继续上传
function stayAndUpload() {
    const modal = document.getElementById('successModal');
    modal.style.display = 'none';
    
    // 清除定时器
    if (autoRedirectTimer) clearTimeout(autoRedirectTimer);
    if (countdownInterval) clearInterval(countdownInterval);

    // 重置表单以便上传下一张
    fileInput.value = '';
    titleInput.value = '';
    authorInput.value = '';
    passwordInput.value = ''; // 【新增】清空密码
    fileNameDisplay.style.display = 'none';
    document.getElementById('result').innerHTML = '';
}

// 【新增】前往画廊
function goToGallery() {
    window.location.href = './shows.html';
}

function showErrorModal(message, title = '提示') {
    const modal = document.getElementById('errorModal');
    const titleEl = document.getElementById('errorModalTitle');
    const msgEl = document.getElementById('errorModalMessage');
    
    if (titleEl) titleEl.innerText = title;
    if (msgEl) msgEl.innerText = message;
    
    modal.style.display = 'flex';
}

// 【新增】关闭错误弹窗
function closeErrorModal() {
    const modal = document.getElementById('errorModal');
    modal.style.display = 'none';
}

// 【新增】点击遮罩层也可以关闭错误弹窗
document.addEventListener('DOMContentLoaded', () => {
    const errorModal = document.getElementById('errorModal');
    if (errorModal) {
        errorModal.addEventListener('click', (e) => {
            if (e.target === errorModal) {
                closeErrorModal();
            }
        });
    }
});

async function hashString(message) {
    const msgBuffer = new TextEncoder().encode(message);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return hashHex;
}

async function handleUpload() {
    const file = fileInput.files[0];
    
    // 【修改】1. 检查是否选择了文件 - 替换 alert
    if (!file) {
        showErrorModal('请先选择要上传的文件', '未选择文件');
        return;
    }

    // 【修改】2. 检查密码必填项 - 替换 alert
    const deletePwd = passwordInput.value.trim();
    let hashedPassword = '';
    if (!deletePwd) {
        showErrorModal('请填写删除密码，这是后续删除文件的唯一凭证！', '缺少必要信息');
        passwordInput.focus();
        return;
    }
    else if (deletePwd) {
        hashedPassword = await hashString(deletePwd);
    }

    // 【原有】3. 限制文件大小... - 替换 alert
    const MAX_SIZE = 100 * 1024 * 1024; 
    if (file.size > MAX_SIZE) {
        showErrorModal(`文件大小超过限制！\n当前大小: ${(file.size / 1024 / 1024).toFixed(2)} MB\n最大允许: 100 MB`, '文件过大');
        return;
    }
    
    // ... 后续代码保持不变 ...
    const customTitle = titleInput.value.trim() || file.name;
    const author = authorInput.value.trim() || '匿名';

    // ... 原有 UI 状态设置代码 ...
    const uploadBtn = document.getElementById('uploadBtn');
    const resultDiv = document.getElementById('result');
    const progressContainer = document.getElementById('progressContainer');
    const progressBar = document.getElementById('progressBar');
    const progressText = document.getElementById('progressText');

    uploadBtn.disabled = true;
    uploadBtn.innerText = '上传中...';
    resultDiv.innerHTML = '';
    progressContainer.style.display = 'block';
    progressBar.style.width = '0%';
    progressText.innerText = '正在初始化...';

    try {
        if (!client) {
            await initOSSClient();
        }

        const isVideo = file.type.startsWith('video/');
        const isImage = file.type.startsWith('image/');

        if (!isVideo && !isImage) {
            // 【修改】替换 alert
            showErrorModal('不支持的文件类型，仅支持视频或图片', '类型错误');
            throw new Error('不支持的文件类型');
        }

        let objectKey = '';
        let metaKey = ''; 

        if (isVideo) {
            progressText.innerText = '正在上传视频...';
            const videoPath = await uploadVideoWithFolder(file);
            objectKey = videoPath;
            metaKey = videoPath.replace(/\.[^/.]+$/, ".m3u8"); 
            console.log(`m3u8 Key: ${metaKey}`);
            
        } else if (isImage) {
            progressText.innerText = '正在上传图片...';
            objectKey = await uploadImage(file);
            metaKey = objectKey; 
        }

        progressText.innerText = '正在保存信息...';

        // 【注意】这里你之前的代码传了 deletePwd，但函数定义只有3个参数，记得去 updateMetadataIndex 加上密码逻辑，或者在这里处理
        // 假设你已经在 updateMetadataIndex 中处理了密码，或者你需要修改该函数签名
        await updateMetadataIndex(metaKey, customTitle, author, hashedPassword);

        const fullUrl = `https://${buckets}.${regionHost}/${objectKey}`;

        progressBar.style.width = '100%';
        progressText.innerText = '上传完成！';
        
        // 【新增】清空密码框
        titleInput.value = '';
        authorInput.value = '';
        passwordInput.value = ''; // 清空密码

        if (file.type.startsWith('image/')) {
            resultDiv.innerHTML = `
                <div class="result-box">
                    <div class="status-success">✅ 图片上传成功</div>
                    <img src="${fullUrl}" alt="${customTitle}" style="max-height: 100px;">
                </div>
            `;
        } else {
             resultDiv.innerHTML = `
                <div class="result-box">
                    <div class="status-success">✅ 视频上传成功 (请确保已转码为 m3u8)</div>
                </div>
            `;
        }

        showSuccessModal();

    } catch (err) {
        console.error(err);
        // 【修改】捕获错误时也使用自定义弹窗，而不是只展示在 resultDiv
        // 如果是因为用户主动取消或非网络错误，可以弹窗提示
        if (err.message !== '不支持的文件类型') {
             showErrorModal(`上传过程中发生错误: ${err.message}`, '上传失败');
        }
        
        resultDiv.innerHTML = `
            <div class="result-box" style="border-left: 4px solid #e74c3c;">
                <div class="status-error">❌ 上传失败</div>
                <p style="font-size: 0.9rem; color: #666;">${err.message}</p>
            </div>
        `;
    } finally {
        uploadBtn.disabled = false;
        uploadBtn.innerText = '开始上传';
        setTimeout(() => {
            progressContainer.style.display = 'none';
        }, 1000);
    }
}


async function uploadImage(file) {
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const fileName = `${Date.now()}_${file.name}`;
    const storeAs = `images/${dateStr}/${fileName}`;
    console.log('开始上传图片:', storeAs);
    await client.put(storeAs, file);
    return storeAs;
}

async function uploadVideoWithFolder(file) {
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const uniqueId = Date.now() + '_' + file.name;
    const folderName = `videos/${dateStr}/${uniqueId}/`;
    const storeAs = `${folderName}${file.name}`;
    console.log('开始分片上传视频:', storeAs);
    
    await client.multipartUpload(storeAs, file, {
        progress: function (p, checkpoint) {
            const percent = Math.floor(p * 100) + '%';
            const progressBar = document.getElementById('progressBar');
            const progressText = document.getElementById('progressText');
            if (progressBar) progressBar.style.width = percent;
            if (progressText) progressText.innerText = `上传中... ${percent}`;
        },
        parallel: 4,
        partSize: 1024 * 1024 * 5
    });

    return `videos/${file.name}`;
}