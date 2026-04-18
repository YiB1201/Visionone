// upload.js
let fileInput, fileNameDisplay, dropZone, titleInput, authorInput, passwordInput;
let autoRedirectTimer = null;
let countdownInterval = null;

function initUploadPage() {
    fileInput = document.getElementById('fileInput');
    if (!fileInput) return; 

    fileNameDisplay = document.getElementById('fileNameDisplay');
    dropZone = document.getElementById('dropZone');
    titleInput = document.getElementById('imageTitle');
    authorInput = document.getElementById('authorName');
    passwordInput = document.getElementById('deletePassword');

    // 强制隐藏弹窗
    const successModal = document.getElementById('successModal');
    const errorModal = document.getElementById('errorModal');
    if (successModal) successModal.style.display = 'none';
    if (errorModal) errorModal.style.display = 'none';

    // ... 事件绑定代码保持不变 ...
    fileInput.addEventListener('change', function () {
        if (this.files && this.files[0]) {
            fileNameDisplay.textContent = `已选择: ${this.files[0].name}`;
            fileNameDisplay.style.display = 'block';
        } else {
            fileNameDisplay.style.display = 'none';
        }
    });
    
    if (dropZone) {
        dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
        dropZone.addEventListener('dragleave', () => { dropZone.classList.remove('dragover'); });
        dropZone.addEventListener('drop', (e) => {
            e.preventDefault(); dropZone.classList.remove('dragover');
            if (e.dataTransfer.files.length) {
                fileInput.files = e.dataTransfer.files;
                fileNameDisplay.textContent = `已选择: ${e.dataTransfer.files[0].name}`;
                fileNameDisplay.style.display = 'block';
            }
        });
    }
    
    if (errorModal) {
        errorModal.addEventListener('click', (e) => { if (e.target === errorModal) closeErrorModal(); });
    }
}

document.addEventListener('DOMContentLoaded', initUploadPage);

// 【简化】上传主逻辑
async function handleUpload() {
    const file = fileInput.files[0];
    if (!file) {
        if (typeof showErrorModal === 'function') showErrorModal('请先选择文件', '未选择');
        else alert('请先选择文件');
        return;
    }

    const deletePwd = passwordInput.value.trim();
    if (!deletePwd) {
        if (typeof showErrorModal === 'function') showErrorModal('请填写删除密码', '缺少信息');
        else alert('请填写删除密码');
        return;
    }

    const MAX_SIZE = 100 * 1024 * 1024; 
    if (file.size > MAX_SIZE) {
        if (typeof showErrorModal === 'function') showErrorModal('文件超过 100MB', '过大');
        else alert('文件过大');
        return;
    }

    const uploadBtn = document.getElementById('uploadBtn');
    const progressContainer = document.getElementById('progressContainer');
    const progressBar = document.getElementById('progressBar');
    const progressText = document.getElementById('progressText');
    const resultDiv = document.getElementById('result');

    uploadBtn.disabled = true;
    uploadBtn.innerText = '上传中...';
    resultDiv.innerHTML = '';
    progressContainer.style.display = 'block';
    
    try {
        // 1. 初始化 OSS (使用统一管理器)
        await ossManager.init();
        const client = ossManager.getClient();
        
        // 2. 哈希密码
        const hashedPwd = await ossManager.hash(deletePwd);

        // 3. 上传文件
        const isVideo = file.type.startsWith('video/');
        let objectKey = '';
        
        if (isVideo) {
            progressText.innerText = '上传视频中...';
            const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
            const uniqueId = Date.now() + '_' + file.name;
            const storeAs = `videos/${dateStr}/${uniqueId}/${file.name}`;
            
            await client.multipartUpload(storeAs, file, {
                progress: (p) => {
                    progressBar.style.width = `${Math.floor(p * 100)}%`;
                    progressText.innerText = `上传中... ${Math.floor(p * 100)}%`;
                }
            });
            objectKey = storeAs;
        } else {
            progressText.innerText = '上传图片中...';
            const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
            const storeAs = `images/${dateStr}/${Date.now()}_${file.name}`;
            await client.put(storeAs, file);
            objectKey = storeAs;
        }

        // 4. 更新元数据 (使用统一管理器)
        progressText.innerText = '保存信息...';
        const title = titleInput.value.trim() || file.name;
        const author = authorInput.value.trim() || '匿名';
        
        // 视频取 m3u8 路径作为 Key，如果是普通上传则直接用 objectKey
        const metaKey = isVideo ? objectKey.replace(/\.[^/.]+$/, ".m3u8") : objectKey;
        
        await ossManager.updateMeta(metaKey, title, author, hashedPwd);

        // 5. 完成
        progressBar.style.width = '100%';
        progressText.innerText = '完成！';
        
        // 显示结果
        const fullUrl = `https://${ossManager.config.bucket}.${ossManager.config.region}.aliyuncs.com/${objectKey}`;
        if (!isVideo) {
            resultDiv.innerHTML = `<div class="result-box"><div class="status-success">✅ 成功</div><img src="${fullUrl}" style="max-height:100px"></div>`;
        } else {
            resultDiv.innerHTML = `<div class="result-box"><div class="status-success">✅ 视频上传成功</div></div>`;
        }

        // 触发成功弹窗
        if (typeof showSuccessModal === 'function') showSuccessModal();
        else alert('上传成功！');

    } catch (err) {
        console.error(err);
        if (typeof showErrorModal === 'function') showErrorModal(err.message, '失败');
        else alert('上传失败: ' + err.message);
        resultDiv.innerHTML = `<div class="result-box status-error">❌ ${err.message}</div>`;
    } finally {
        uploadBtn.disabled = false;
        uploadBtn.innerText = '开始上传';
        setTimeout(() => { progressContainer.style.display = 'none'; }, 1000);
    }
}

// ... stayAndUpload, goToGallery, showSuccessModal 等 UI 辅助函数保持不变 ...
function showSuccessModal() {
    const modal = document.getElementById('successModal');
    const countdownEl = document.getElementById('countdownText');
    modal.style.display = 'flex';
    let seconds = 5;
    countdownEl.innerText = seconds;
    if (autoRedirectTimer) clearTimeout(autoRedirectTimer);
    if (countdownInterval) clearInterval(countdownInterval);
    countdownInterval = setInterval(() => {
        seconds--;
        countdownEl.innerText = seconds;
        if (seconds <= 0) clearInterval(countdownInterval);
    }, 1000);
    autoRedirectTimer = setTimeout(() => { window.location.href = './shows.html'; }, 5000);
}

function stayAndUpload() {
    document.getElementById('successModal').style.display = 'none';
    if (autoRedirectTimer) clearTimeout(autoRedirectTimer);
    if (countdownInterval) clearInterval(countdownInterval);
    fileInput.value = ''; titleInput.value = ''; authorInput.value = ''; passwordInput.value = '';
    fileNameDisplay.style.display = 'none';
    document.getElementById('result').innerHTML = '';
}

function showErrorModal(message, title) {
    const modal = document.getElementById('errorModal');
    document.getElementById('errorModalTitle').innerText = title;
    document.getElementById('errorModalMessage').innerText = message;
    modal.style.display = 'flex';
}
function closeErrorModal() { document.getElementById('errorModal').style.display = 'none'; }
function goToGallery() { window.location.href = './shows.html'; }