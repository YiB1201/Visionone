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

    // 【修改】监听 change 事件，显示文件数量
    fileInput.addEventListener('change', function () {
        const count = this.files.length;
        if (count > 0) {
            if (count === 1) {
                fileNameDisplay.textContent = `已选择: ${this.files[0].name}`;
            } else {
                fileNameDisplay.textContent = `已选择 ${count} 张图片`;
            }
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
                const count = e.dataTransfer.files.length;
                fileNameDisplay.textContent = count === 1 ? `已选择: ${e.dataTransfer.files[0].name}` : `已选择 ${count} 张图片`;
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
    const indexFile = 'images/index.json';

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
        password: password, 
        likes: 0, 
        updateTime: Date.now() 
    };
    
    if (existingIndex >= 0) {
        newItem.likes = metadataList[existingIndex].likes || 0;
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
    // document.getElementById('result').innerHTML = '';
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
     const files = Array.from(fileInput.files); // 转换为数组以便操作
    
    if (files.length === 0) {
        showErrorModal('请先选择要上传的文件', '未选择文件');
        return;
    }

    // 【修复】在函数最开始就锁定元数据，防止任何潜在的 DOM 变化影响
    const baseTitle = titleInput.value.trim();
    if (!baseTitle) {
        showErrorModal('请填写图片标题，这是必填项！', '缺少必要信息');
        titleInput.focus();
        return;
    }

    const deletePwd = passwordInput.value.trim();
    if (!deletePwd) {
        showErrorModal('请填写删除密码，这是后续删除文件的唯一凭证！', '缺少必要信息');
        passwordInput.focus();
        return;
    }
    
    // 预先计算哈希，只算一次
    let hashedPassword = '';
    try {
        hashedPassword = await hashString(deletePwd);
    } catch (e) {
        showErrorModal('密码加密失败，请重试', '错误');
        return;
    }

    const globalAuthor = authorInput.value.trim() || '匿名';
    const isBatch = files.length > 1; 

    // 2. 预检查：文件大小和类型
    const MAX_SIZE = 100 * 1024 * 1024; 
    const invalidFiles = [];
    
    files.forEach(file => {
        if (!file.type.startsWith('image/')) {
            invalidFiles.push(`${file.name} (非图片)`);
        } else if (file.size > MAX_SIZE) {
            invalidFiles.push(`${file.name} (超过100MB)`);
        }
    });

    if (invalidFiles.length > 0) {
        showErrorModal(`以下文件不符合要求，已跳过：\n${invalidFiles.join('\n')}`, '部分文件无效');
    }

    const validFiles = files.filter(file => 
        file.type.startsWith('image/') && file.size <= MAX_SIZE
    );

    if (validFiles.length === 0) {
        showErrorModal('没有符合要求的图片可上传', '上传失败');
        return;
    }

    // UI 状态设置
    const uploadBtn = document.getElementById('uploadBtn');
    const resultDiv = document.getElementById('result');
    const progressContainer = document.getElementById('progressContainer');
    const progressBar = document.getElementById('progressBar');
    const progressText = document.getElementById('progressText');

    uploadBtn.disabled = true;
    uploadBtn.innerText = `上传中 (0/${validFiles.length})`;
    resultDiv.innerHTML = '<div style="margin-top:10px; font-size:0.9rem; color:#666;">正在处理队列...</div>';
    progressContainer.style.display = 'block';
    progressBar.style.width = '0%';
    progressText.innerText = '初始化批量上传...';

    let successCount = 0;
    let failCount = 0;
    const total = validFiles.length;
    
    // 【修复】存储完整的元数据，而不仅仅是 key
    const uploadResults = []; 

    try {
        if (!client) {
            await initOSSClient();
        }

        // 【并发控制】同时上传的数量，建议 3-5 个
        const CONCURRENCY = 3;
        
        // 执行队列
        for (let i = 0; i < total; i += CONCURRENCY) {
            const batch = validFiles.slice(i, i + CONCURRENCY);
            
            // 【修复】在 map 之前确定这批文件的标题，避免闭包问题（虽然 let/const 块级作用域通常没问题，但显式传递更安全）
            const batchPromises = batch.map(async (file, indexInBatch) => {
                try {
                    progressText.innerText = `正在上传: ${file.name}`;
                    
                    // 生成标题
                    const globalIndex = i + indexInBatch + 1; 
                    const finalTitle = isBatch ? `${baseTitle}-${globalIndex}` : baseTitle;
                    
                    // 上传文件
                    const objectKey = await uploadImage(file);
                    
                    // 【关键】记录完整的结果，包括标题和密码
                    uploadResults.push({
                        objectKey: objectKey,
                        title: finalTitle,
                        author: globalAuthor,
                        password: hashedPassword,
                        fileName: file.name
                    });
                    
                    successCount++;
                    return { status: 'success', name: file.name };
                } catch (err) {
                    console.error(`Upload failed for ${file.name}:`, err);
                    failCount++;
                    return { status: 'fail', name: file.name, error: err.message };
                }
            });

            // 等待当前批次完成
            const results = await Promise.all(batchPromises);
            
            // 更新进度条
            const currentProgress = Math.floor(((i + batch.length) / total) * 100);
            progressBar.style.width = `${currentProgress}%`;
            uploadBtn.innerText = `上传中 (${successCount + failCount}/${total})`;
            
            // 实时更新结果列表
            results.forEach(res => {
                const div = document.createElement('div');
                div.style.fontSize = '0.85rem';
                div.style.padding = '2px 0';
                if (res.status === 'success') {
                    div.style.color = 'green';
                    div.innerText = `✅ ${res.name}上传成功`;
                } else {
                    div.style.color = 'red';
                    div.innerText = `❌ ${res.name}上传失败: ${res.error}`;
                }
                resultDiv.innerHTML = div.outerHTML;
            });
        }

        // 【关键修复】所有文件上传完成后，【一次性】批量更新元数据索引
        if (uploadResults.length > 0) {
            progressText.innerText = '正在同步元数据...';
            
            // 1. 获取当前远程索引
            let metadataList = [];
            try {
                const result = await client.get('images/index.json');
                const content = new TextDecoder("utf-8").decode(result.content);
                metadataList = JSON.parse(content);
                if (!Array.isArray(metadataList)) metadataList = [];
            } catch (e) {
                console.warn('远程索引不存在，将创建新索引', e);
                metadataList = [];
            }

            // 2. 在内存中合并新数据
            uploadResults.forEach(item => {
                // 检查是否已存在（理论上批量上传新文件不应存在，但为了健壮性）
                const existingIndex = metadataList.findIndex(m => m.key === item.objectKey);
                
                const newItem = { 
                    key: item.objectKey, 
                    title: item.title,      // 确保标题不为空
                    author: item.author, 
                    password: item.password, // 确保密码不为空
                    likes: 0, 
                    updateTime: Date.now() 
                };
                
                if (existingIndex >= 0) {
                    // 如果存在，保留原有的点赞数，但更新标题和密码（因为是新上传覆盖）
                    newItem.likes = metadataList[existingIndex].likes || 0;
                    metadataList[existingIndex] = newItem;
                } else {
                    metadataList.push(newItem);
                }
            });

            // 3. 一次性写入远程
            const jsonStr = JSON.stringify(metadataList, null, 2);
            const blob = new Blob([jsonStr], { type: 'application/json' });
            await client.put('images/index.json', blob);
            console.log('元数据索引批量更新成功');
        }

        progressBar.style.width = '100%';
        progressText.innerText = `全部完成！成功: ${successCount}, 失败: ${failCount}`;
        uploadBtn.innerText = '上传完成';
        
        // 清空输入
        titleInput.value = '';
        authorInput.value = '';
        passwordInput.value = '';
        fileInput.value = ''; 
        fileNameDisplay.style.display = 'none';

        if (failCount === 0) {
            showSuccessModal();
        } else {
            showErrorModal(`上传结束：成功: ${successCount}, 失败: ${failCount}`, '部分成功');
        }

    } catch (err) {
        console.error(err);
        showErrorModal(`批量上传发生严重错误: ${err.message}`, '系统错误');
    } finally {
        uploadBtn.disabled = false;
        uploadBtn.innerText = '开始批量上传';
        setTimeout(() => {
            progressContainer.style.display = 'none';
        }, 2000);
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
