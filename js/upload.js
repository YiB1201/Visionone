let client = null;
let regionHost = null;
let buckets = null;

// 文件选择显示文件名
const fileInput = document.getElementById('fileInput');
const fileNameDisplay = document.getElementById('fileNameDisplay');
const dropZone = document.getElementById('dropZone');
const titleInput = document.getElementById('imageTitle');
const authorInput = document.getElementById('authorName');

// 【新增】弹窗相关变量
let autoRedirectTimer = null;
let countdownInterval = null;

fileInput.addEventListener('change', function () {
    if (this.files && this.files[0]) {
        fileNameDisplay.textContent = `已选择: ${this.files[0].name}`;
        fileNameDisplay.style.display = 'block';
    } else {
        fileNameDisplay.style.display = 'none';
    }
});

// 拖拽效果
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

//获取 STS 签名并初始化 OSS Client
async function initOSSClient() {
    try {
        const response = await fetch('https://oss-upload-sign-uhwltmbygx.cn-hangzhou.fcapp.run', {
            method: 'POST'
        });

        if (!response.ok) throw new Error('获取签名失败');

        const stsData = await response.json();
        const { region, bucket, accessKeyId, accessKeySecret, stsToken } = stsData;
        regionHost = `${region}.aliyuncs.com`;
        buckets = bucket;

        client = new OSS({
            region: region,
            bucket: bucket,
            accessKeyId: accessKeyId,
            accessKeySecret: accessKeySecret,
            stsToken: stsToken,
            refreshSTSToken: async () => {
                const freshResponse = await fetch('https://oss-upload-sign-uhwltmbygx.cn-hangzhou.fcapp.run', { method: 'POST' });
                const freshData = await freshResponse.json();
                return {
                    accessKeyId: freshData.accessKeyId,
                    accessKeySecret: freshData.accessKeySecret,
                    stsToken: freshData.stsToken
                };
            },
            refreshSTSTokenInterval: 300000
        });

        console.log('OSS Client 初始化成功');
    } catch (err) {
        console.error('初始化 OSS 失败:', err);
        alert('初始化上传环境失败，请检查网络或后端服务');
        throw err;
    }
}

// upload.js 中的修改建议

// 修改函数签名，或者直接根据 objectKey 判断
async function updateMetadataIndex(objectKey, title, author) {
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
    const newItem = { 
        key: objectKey, 
        title: title, 
        author: author, 
        likes: 0, 
        updateTime: Date.now() 
    };
    
    if (existingIndex >= 0) {
        newItem.likes = metadataList[existingIndex].likes || 0;
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
    fileNameDisplay.style.display = 'none';
    document.getElementById('result').innerHTML = '';
}

// 【新增】前往画廊
function goToGallery() {
    window.location.href = './shows.html';
}

async function handleUpload() {
    const file = fileInput.files[0];
    if (!file) {
        alert('请先选择文件');
        return;
    }
    
    const customTitle = titleInput.value.trim() || file.name;
    const author = authorInput.value.trim() || '匿名';

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
            throw new Error('不支持的文件类型，仅支持视频或图片');
        }

        let objectKey = '';
        let metaKey = ''; // 【新增】用于元数据索引的 Key

        if (isVideo) {
            progressText.innerText = '正在上传视频...';
            // 1. 获取视频上传后的实际路径
            const videoPath = await uploadVideoWithFolder(file);
            objectKey = videoPath;
            metaKey = videoPath.replace(/\.[^/.]+$/, ".m3u8"); 
            console.log(`m3u8 Key: ${metaKey}`);
            
        } else if (isImage) {
            progressText.innerText = '正在上传图片...';
            objectKey = await uploadImage(file);
            metaKey = objectKey; // 图片 Key 不变
        }

        progressText.innerText = '正在保存信息...';
        
        // 3. 使用 metaKey (即 .m3u8 的路径) 更新索引
        await updateMetadataIndex(metaKey, customTitle, author);

        const fullUrl = `https://${buckets}.${regionHost}/${objectKey}`;

        progressBar.style.width = '100%';
        progressText.innerText = '上传完成！';
        
        titleInput.value = '';
        authorInput.value = '';

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