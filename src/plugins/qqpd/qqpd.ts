import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { SearchResult, Link, PluginSearchResult } from '../../../model';
import { FilterResultsByKeyword } from '../../../util/plugin.util';

// 插件配置参数（代码内配置）
const MaxConcurrentUsers = 10;    // 最多使用的用户数
const MaxConcurrentChannels = 50; // 最大并发频道数
const DebugLog = false;          // 调试日志开关（临时开启排查问题）

// 存储目录 - 从环境变量动态获取
let StorageDir: string;

// HTML模板（完整的管理页面）
const HTMLTemplate = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>PanSou QQ频道搜索配置</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            padding: 20px;
        }
        .container {
            max-width: 800px;
            margin: 0 auto;
            background: white;
            border-radius: 16px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            overflow: hidden;
        }
        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 30px;
            text-align: center;
        }
        .section {
            padding: 30px;
            border-bottom: 1px solid #eee;
        }
        .section:last-child { border-bottom: none; }
        .section-title {
            font-size: 18px;
            font-weight: bold;
            margin-bottom: 15px;
            color: #333;
        }
        .status-box {
            background: #f8f9fa;
            padding: 20px;
            border-radius: 8px;
            margin-bottom: 15px;
        }
        .status-item {
            display: flex;
            justify-content: space-between;
            padding: 8px 0;
        }
        .qrcode-container {
            text-align: center;
            padding: 20px;
        }
        .qrcode-img {
            max-width: 200px;
            border: 2px solid #ddd;
            border-radius: 8px;
        }
        .btn {
            padding: 10px 20px;
            border: none;
            border-radius: 6px;
            cursor: pointer;
            font-size: 14px;
            transition: all 0.3s;
        }
        .btn-primary {
            background: #667eea;
            color: white;
        }
        .btn-primary:hover { background: #5568d3; }
        .btn-danger {
            background: #f56565;
            color: white;
        }
        .btn-danger:hover { background: #e53e3e; }
        .btn-secondary {
            background: #e2e8f0;
            color: #333;
        }
        .btn-secondary:hover { background: #cbd5e0; }
        textarea {
            width: 100%;
            padding: 10px 15px;
            border: 1px solid #ddd;
            border-radius: 6px;
            font-size: 14px;
            resize: vertical;
            font-family: monospace;
        }
        .test-results {
            max-height: 300px;
            overflow-y: auto;
            background: #f8f9fa;
            padding: 15px;
            border-radius: 6px;
            margin-top: 10px;
        }
        .hidden { display: none; }
        .alert {
            padding: 12px 15px;
            border-radius: 6px;
            margin: 10px 0;
        }
        .alert-success {
            background: #c6f6d5;
            color: #22543d;
        }
        .alert-error {
            background: #fed7d7;
            color: #742a2a;
        }
        .api-code {
            background: #2d3748;
            color: #68d391;
            padding: 10px;
            border-radius: 6px;
            font-family: 'Courier New', monospace;
            font-size: 12px;
            overflow-x: auto;
            margin: 10px 0;
            white-space: pre-wrap;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🔍 PanSou QQ频道搜索</h1>
            <p>配置你的专属搜索服务</p>
            <p style="font-size: 12px; margin-top: 10px; opacity: 0.8;">
                🔗 当前地址: <span id="current-url">HASH_PLACEHOLDER</span>
            </p>
        </div>

        <div class="section" id="login-section">
            <div class="section-title">📱 登录状态</div>
            
            <div id="logged-in-view" class="hidden">
                <div style="text-align: center; padding: 20px;">
                    <div style="width: 100px; height: 100px; margin: 0 auto 15px; border-radius: 50%; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); display: flex; align-items: center; justify-content: center; color: white; font-size: 36px; font-weight: bold;">
                        <span id="qq-avatar">QQ</span>
                    </div>
                </div>
                <div class="status-box">
                    <div class="status-item">
                        <span>状态</span>
                        <span><strong style="color: #48bb78;">✅ 已登录</strong></span>
                    </div>
                    <div class="status-item">
                        <span>QQ号</span>
                        <span id="qq-masked">-</span>
                    </div>
                    <div class="status-item">
                        <span>登录时间</span>
                        <span id="login-time">-</span>
                    </div>
                    <div class="status-item">
                        <span>有效期</span>
                        <span id="expire-info">-</span>
                    </div>
                </div>
                <button class="btn btn-danger" onclick="logout()">退出登录</button>
            </div>

            <div id="not-logged-in-view" class="hidden">
                <div class="qrcode-container">
                    <img id="qrcode-img" class="qrcode-img" src="" alt="二维码">
                    <p style="margin-top: 10px; color: #666;">
                        请使用手机QQ扫描二维码登录
                    </p>
                    <p style="font-size: 12px; color: #999;">扫码后自动检测登录状态</p>
                    <button class="btn btn-secondary" onclick="refreshQRCode()" style="margin-top: 10px;">
                        刷新二维码
                    </button>
                </div>
            </div>
        </div>

        <div class="section" id="channels-section">
            <div class="section-title">📋 频道管理 (<span id="channel-count">0</span> 个)</div>
            
            <div id="alert-box"></div>
            
            <p style="margin-bottom: 10px; color: #666;">每行一个频道号或链接，保存时自动去重</p>
            <textarea id="channels-textarea" rows="10" placeholder="pd97631607
kuake12345
languan8K115"></textarea>
            
            <button class="btn btn-primary" onclick="saveChannels()" style="margin-top: 10px;">保存频道配置</button>
        </div>

        <div class="section" id="test-section">
            <div class="section-title">🔍 测试搜索(限制返回10条数据)</div>
            
            <div style="display: flex; gap: 10px;">
                <input type="text" id="search-keyword" placeholder="输入关键词测试搜索" style="flex: 1; padding: 10px; border: 1px solid #ddd; border-radius: 6px;">
                <button class="btn btn-primary" onclick="testSearch()">搜索</button>
            </div>

            <div id="search-results" class="test-results hidden"></div>
        </div>

        <div class="section">
            <div class="section-title">📖 API调用说明</div>
            
            <p style="margin-bottom: 15px;">你可以通过API程序化管理频道和搜索：</p>

            <details>
                <summary style="cursor: pointer; padding: 10px 0; font-weight: bold;">获取状态</summary>
                <div class="api-code">curl -X POST https://your-domain.com/qqpd/HASH_PLACEHOLDER \
  -H "Content-Type: application/json" \
  -d '{"action": "get_status"}'</div>
            </details>

            <details>
                <summary style="cursor: pointer; padding: 10px 0; font-weight: bold;">设置频道列表</summary>
                <div class="api-code">curl -X POST https://your-domain.com/qqpd/HASH_PLACEHOLDER \
  -H "Content-Type: application/json" \
  -d '{"action": "set_channels", "channels": ["pd97631607", "kuake12345"]}'</div>
            </details>

            <details>
                <summary style="cursor: pointer; padding: 10px 0; font-weight: bold;">测试搜索</summary>
                <div class="api-code">curl -X POST https://your-domain.com/qqpd/HASH_PLACEHOLDER \
  -H "Content-Type: application/json" \
  -d '{"action": "test_search", "keyword": "遮天"}'</div>
            </details>
        </div>
    </div>

    <script>
        const HASH = 'HASH_PLACEHOLDER';
        const API_URL = '/qqpd/' + HASH;
        let statusCheckInterval = null;
        let loginCheckInterval = null;

        window.onload = function() {
            updateStatus();
            startStatusPolling();
        };

        function startStatusPolling() {
            statusCheckInterval = setInterval(updateStatus, 3000);
        }

        function startLoginPolling() {
            if (loginCheckInterval) return; // 避免重复启动
            loginCheckInterval = setInterval(checkLogin, 2000);
        }

        function stopLoginPolling() {
            if (loginCheckInterval) {
                clearInterval(loginCheckInterval);
                loginCheckInterval = null;
            }
        }

        async function postAction(action, extraData = {}) {
            try {
                const response = await fetch(API_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: action, ...extraData })
                });
                return await response.json();
            } catch (error) {
                console.error('请求失败:', error);
                return { success: false, message: '请求失败: ' + error.message };
            }
        }

        async function updateStatus() {
            const result = await postAction('get_status');
            if (result.success && result.data) {
                const data = result.data;
                
                if (data.logged_in === true && data.status === 'active') {
                    // 已登录：显示用户信息，隐藏二维码
                    document.getElementById('logged-in-view').classList.remove('hidden');
                    document.getElementById('not-logged-in-view').classList.add('hidden');
                    
                    // 更新用户信息
                    const qqMasked = data.qq_masked || 'QQ';
                    document.getElementById('qq-masked').textContent = qqMasked;
                    document.getElementById('login-time').textContent = data.login_time || '-';
                    document.getElementById('expire-info').textContent = '剩余 ' + (data.expires_in_days || 0) + ' 天';
                    
                    // 显示QQ号首位作为头像
                    const firstChar = qqMasked.charAt(0) || 'Q';
                    document.getElementById('qq-avatar').textContent = firstChar;
                    
                    // 停止登录检测
                    stopLoginPolling();
                } else {
                    // 未登录：显示二维码，隐藏用户信息
                    document.getElementById('logged-in-view').classList.add('hidden');
                    document.getElementById('not-logged-in-view').classList.remove('hidden');
                    
                    if (data.qrcode_base64) {
                        document.getElementById('qrcode-img').src = data.qrcode_base64;
                    }
                    
                    // 启动登录检测（每2秒检查一次）
                    startLoginPolling();
                }

                updateChannelList(data.channels || []);
            }
        }

        async function checkLogin() {
            const result = await postAction('check_login');
            if (result.success && result.data) {
                if (result.data.login_status === 'success') {
                    // 登录成功，停止轮询并刷新状态
                    stopLoginPolling();
                    showAlert('登录成功！');
                    updateStatus();
                }
            }
        }

        function updateChannelList(channels) {
            const textarea = document.getElementById('channels-textarea');
            const count = document.getElementById('channel-count');
            
            count.textContent = channels.length;
            
            // 只在用户没有聚焦输入框时更新内容
            if (document.activeElement !== textarea) {
                textarea.value = channels.join('\n');
            }
        }

        function showAlert(message, type = 'success') {
            const alertBox = document.getElementById('alert-box');
            alertBox.innerHTML = '<div class="alert alert-' + type + '">' + message + '</div>';
            setTimeout(() => {
                alertBox.innerHTML = '';
            }, 3000);
        }

        async function refreshQRCode() {
            const result = await postAction('refresh_qrcode');
            if (result.success) {
                showAlert(result.message);
                updateStatus();
                // 启动登录检测
                startLoginPolling();
            } else {
                showAlert(result.message, 'error');
            }
        }

        async function logout() {
            if (!confirm('确定要退出登录吗？')) return;
            
            const result = await postAction('logout');
            if (result.success) {
                showAlert(result.message);
                updateStatus();
            } else {
                showAlert(result.message, 'error');
            }
        }

        async function saveChannels() {
            const textarea = document.getElementById('channels-textarea');
            const channelsText = textarea.value.trim();
            
            const channels = channelsText
                .split('\n')
                .map(line => line.trim())
                .filter(line => line.length > 0);
            
            const result = await postAction('set_channels', { channels });
            if (result.success) {
                showAlert(result.message);
                updateStatus();
            } else {
                showAlert(result.message, 'error');
            }
        }

        async function testSearch() {
            const keyword = document.getElementById('search-keyword').value.trim();
            
            if (!keyword) {
                showAlert('请输入搜索关键词', 'error');
                return;
            }

            const resultsDiv = document.getElementById('search-results');
            resultsDiv.classList.remove('hidden');
            resultsDiv.innerHTML = '<div>🔍 搜索中...</div>';

            const result = await postAction('test_search', { keyword });
            
            if (result.success) {
                const results = result.data.results || [];
                
                if (results.length === 0) {
                    resultsDiv.innerHTML = '<p style="text-align: center; color: #999;">未找到结果</p>';
                    return;
                }

                let html = '<p><strong>找到 ' + result.data.total_results + ' 条结果</strong></p>';
                results.forEach((item, index) => {
                    html += '<div style="margin: 15px 0; padding: 10px; background: white; border-radius: 6px;">';
                    html += '<p><strong>' + (index + 1) + '. ' + item.title + '</strong></p>';
                    item.links.forEach(link => {
                        html += '<p style="font-size: 12px; color: #666; margin: 5px 0; word-break: break-all;">';
                        html += '[' + link.type + '] ' + link.url;
                        if (link.password) html += ' 密码: ' + link.password;
                        html += '</p>';
                    });
                    html += '</div>';
                });
                resultsDiv.innerHTML = html;
            } else {
                resultsDiv.innerHTML = '<p style="color: red;">' + result.message + '</p>';
            }
        }

        document.getElementById('search-keyword').addEventListener('keypress', function(e) {
            if (e.key === 'Enter') testSearch();
        });
    </script>
</body>
</html>`;

// User 用户数据结构
interface User {
    Hash: string;
    QQMasked: string;
    Cookie: string;
    Status: string;
    Channels: string[];
    ChannelGuildIDs: Record<string, string>; // 频道号->guild_id映射（持久化缓存）
    CreatedAt: Date;
    LoginAt: Date;
    ExpireAt: Date;
    LastAccessAt: Date;

    // 二维码相关（不持久化）
    QRCodeCache?: Buffer;
    QRCodeCacheTime?: Date;
    Qrsig?: string;
}

// ChannelTask 频道搜索任务
interface ChannelTask {
    ChannelID: string;
    GuildID: string;
    UserHash: string;
    Cookie: string;
}

// LoginResult 登录检测结果
interface LoginResult {
    Status: string; // success/waiting/expired/error
    Cookie: string; // 完整Cookie（登录成功时）
    QQMasked: string; // 脱敏QQ号
}

// QQPDPlugin 插件结构
class QQPDPlugin {
    private name: string;
    private users: Map<string, User>; // 内存缓存：hash -> User
    private initialized: boolean;
    private MainCacheKey: string;
    private axiosInstance: AxiosInstance;

    constructor() {
        this.name = 'qqpd';
        this.users = new Map();
        this.initialized = false;
        this.MainCacheKey = this.name;
        this.axiosInstance = axios.create({
            timeout: 10000, // 10秒超时
            httpsAgent: new (require('https').Agent)({
                rejectUnauthorized: false
            })
        });
        
        // 初始化存储目录
        this.initializeStorageDir();
    }

    // 初始化存储目录
    private initializeStorageDir(): void {
        const cachePath = process.env.CACHE_PATH || './cache';
        StorageDir = path.join(cachePath, 'qqpd_users');
        
        // 创建存储目录
        if (!fs.existsSync(StorageDir)) {
            fs.mkdirSync(StorageDir, { recursive: true });
        }
    }

    // Initialize 实现 InitializablePlugin 接口，延迟初始化插件
    async Initialize(): Promise<void> {
        if (this.initialized) {
            return;
        }

        // 加载所有用户到内存
        this.loadAllUsers();

        // 启动定期清理任务
        this.startCleanupTask();

        this.initialized = true;
    }

    // Name 返回插件名称
    Name(): string {
        return this.name;
    }

    // Search 执行搜索并返回结果（兼容性方法）
    async Search(keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
        const result = await this.SearchWithResult(keyword, ext);
        return result.Results;
    }

    // SearchWithResult 执行搜索并返回包含IsFinal标记的结果
    async SearchWithResult(keyword: string, ext: Record<string, any>): Promise<PluginSearchResult> {
        if (DebugLog) {
            console.log(`[QQPD] ========== 开始搜索: ${keyword} ==========`);
        }

        // 确保插件已初始化
        if (!this.initialized) {
            await this.Initialize();
        }

        // 1. 获取所有有效用户
        const users = this.getActiveUsers();
        if (DebugLog) {
            console.log(`[QQPD] 找到 ${users.length} 个有效用户`);
        }

        if (users.length === 0) {
            if (DebugLog) {
                console.log('[QQPD] 没有有效用户，返回空结果');
            }
            return {
                Results: [],
                IsFinal: true,
                CacheKey: this.MainCacheKey
            };
        }

        // 2. 限制用户数量（取最近活跃的）
        let selectedUsers = users;
        if (users.length > MaxConcurrentUsers) {
            selectedUsers.sort((a, b) => {
                return b.LastAccessAt.getTime() - a.LastAccessAt.getTime();
            });
            selectedUsers = selectedUsers.slice(0, MaxConcurrentUsers);
            if (DebugLog) {
                console.log(`[QQPD] 限制用户数量为: ${MaxConcurrentUsers}`);
            }
        }

        // 3. 收集并去重频道，智能分配给用户
        const tasks = this.buildChannelTasks(selectedUsers);
        if (DebugLog) {
            console.log(`[QQPD] 生成 ${tasks.length} 个频道任务（去重后）`);
            for (let i = 0; i < Math.min(tasks.length, 5); i++) {
                const task = tasks[i];
                console.log(`[QQPD]   任务${i+1}: 频道=${task.ChannelID}, 用户=${task.UserHash.slice(0, 8)}...`);
            }
        }

        // 4. 并发执行所有任务
        const results = await this.executeTasks(tasks, keyword);
        if (DebugLog) {
            console.log(`[QQPD] 所有任务完成，获得 ${results.length} 条原始结果`);
        }

        if (DebugLog) {
            console.log(`[QQPD] 返回 ${results.length} 条结果（交由Service层过滤）`);
            console.log('[QQPD] ========== 搜索完成 ==========');
        }

        return {
            Results: results,
            IsFinal: true,
            CacheKey: this.MainCacheKey
        };
    }

    // ============ 内存缓存管理 ============

    // loadAllUsers 启动时加载所有用户到内存
    private loadAllUsers(): void {
        try {
            const files = fs.readdirSync(StorageDir);
            let count = 0;

            for (const file of files) {
                if (path.extname(file) !== '.json') {
                    continue;
                }

                const filePath = path.join(StorageDir, file);
                const data = fs.readFileSync(filePath, 'utf-8');
                
                try {
                    const user: User = JSON.parse(data);
                    // 转换日期字符串为Date对象
                    user.CreatedAt = new Date(user.CreatedAt);
                    user.LoginAt = new Date(user.LoginAt);
                    user.ExpireAt = new Date(user.ExpireAt);
                    user.LastAccessAt = new Date(user.LastAccessAt);
                    
                    // 加载到内存
                    this.users.set(user.Hash, user);
                    count++;
                } catch (err) {
                    console.error(`[QQPD] 解析用户文件失败: ${file}`, err);
                }
            }

            console.log(`[QQPD] 已加载 ${count} 个用户到内存`);
        } catch (err) {
            console.error('[QQPD] 加载用户失败', err);
        }
    }

    // getUserByHash 获取用户（从内存）
    private getUserByHash(hash: string): User | undefined {
        return this.users.get(hash);
    }

    // saveUser 保存用户（内存+文件）
    private async saveUser(user: User): Promise<void> {
        // 更新内存
        this.users.set(user.Hash, user);

        // 持久化到文件
        await this.persistUser(user);
    }

    // persistUser 持久化用户到文件
    private async persistUser(user: User): Promise<void> {
        const filePath = path.join(StorageDir, user.Hash + '.json');
        
        // 创建一个不包含不持久化字段的副本
        const userToSave = { ...user };
        delete userToSave.QRCodeCache;
        delete userToSave.QRCodeCacheTime;
        delete userToSave.Qrsig;

        try {
            await fs.promises.writeFile(filePath, JSON.stringify(userToSave, null, 2), 'utf-8');
        } catch (err) {
            console.error(`[QQPD] 保存用户失败: ${user.Hash}`, err);
        }
    }

    // deleteUser 删除用户（内存+文件）
    private async deleteUser(hash: string): Promise<void> {
        // 从内存删除
        this.users.delete(hash);

        // 从文件删除
        const filePath = path.join(StorageDir, hash + '.json');
        try {
            await fs.promises.unlink(filePath);
        } catch (err) {
            console.error(`[QQPD] 删除用户文件失败: ${filePath}`, err);
        }
    }

    // getActiveUsers 获取有效的活跃用户
    private getActiveUsers(): User[] {
        const users: User[] = [];
        
        let totalUsers = 0;
        let activeUsers = 0;
        let expiredUsers = 0;
        let noChannelUsers = 0;

        for (const user of this.users.values()) {
            totalUsers++;

            // 双重过滤
            if (user.Status !== 'active') {
                if (DebugLog && totalUsers <= 3) {
                    console.log(`[QQPD]   用户${user.Hash.slice(0, 8)}...: 状态=${user.Status} (非active，跳过)`);
                }
                continue;
            }

            // 检查Cookie是否过期（根据ExpireAt时间判断）
            if (new Date() > user.ExpireAt) {
                // Cookie已过期，标记用户状态为过期
                expiredUsers++;
                user.Status = 'expired';
                user.Cookie = '';
                this.saveUser(user);
                if (DebugLog && expiredUsers <= 3) {
                    console.log(`[QQPD]   用户${user.Hash.slice(0, 8)}...: Cookie已过期 (过期时间: ${user.ExpireAt.toISOString()})`);
                }
                continue;
            }

            if (user.Channels.length === 0) {
                noChannelUsers++;
                if (DebugLog && noChannelUsers <= 3) {
                    console.log(`[QQPD]   用户${user.Hash.slice(0, 8)}...: 频道数=0 (跳过)`);
                }
                continue;
            }

            // 通过所有过滤
            activeUsers++;
            if (DebugLog && activeUsers <= 3) {
                const remainingDays = Math.floor((user.ExpireAt.getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24));
                console.log(`[QQPD]   用户${user.Hash.slice(0, 8)}...: 有效 (频道数=${user.Channels.length}, 剩余有效期=${remainingDays}天)`);
            }
            users.push(user);
        }

        if (DebugLog) {
            console.log(`[QQPD] 用户统计: 总数=${totalUsers}, 有效=${activeUsers}, 已过期=${expiredUsers}, 无频道=${noChannelUsers}`);
        }

        return users;
    }

    // ============ 搜索逻辑 ============

    // buildChannelTasks 构建频道任务列表（去重+负载均衡）
    private buildChannelTasks(users: User[]): ChannelTask[] {
        // 1. 收集所有频道及其所属用户
        const channelOwners = new Map<string, User[]>();

        for (const user of users) {
            for (const channelID of user.Channels) {
                const owners = channelOwners.get(channelID) || [];
                owners.push(user);
                channelOwners.set(channelID, owners);
            }
        }

        // 2. 为每个频道分配一个用户（负载均衡）
        const tasks: ChannelTask[] = [];
        const userTaskCount = new Map<string, number>();

        for (const [channelID, owners] of channelOwners.entries()) {
            // 选择任务最少的用户来执行
            let selectedUser = owners[0];
            let minTasks = userTaskCount.get(selectedUser.Hash) || 0;

            for (const owner of owners) {
                const count = userTaskCount.get(owner.Hash) || 0;
                if (count < minTasks) {
                    selectedUser = owner;
                    minTasks = count;
                }
            }

            // 从缓存中获取guild_id（优先使用缓存）
            let guildID = '';
            if (selectedUser.ChannelGuildIDs && selectedUser.ChannelGuildIDs[channelID]) {
                guildID = selectedUser.ChannelGuildIDs[channelID];
                if (DebugLog) {
                    console.log(`[QQPD]   频道 ${channelID}: 使用缓存的guild_id ${guildID}`);
                }
            }

            // 如果缓存中没有，实时获取（这种情况应该很少发生）
            if (!guildID) {
                guildID = this.extractGuildIDFromChannelNumber(channelID);
                if (DebugLog) {
                    console.log(`[QQPD]   频道 ${channelID}: 缓存未命中，实时获取guild_id ${guildID}`);
                }
            }

            // 创建任务
            tasks.push({
                ChannelID: channelID,
                GuildID: guildID,
                UserHash: selectedUser.Hash,
                Cookie: selectedUser.Cookie
            });

            // 更新任务计数
            userTaskCount.set(selectedUser.Hash, (userTaskCount.get(selectedUser.Hash) || 0) + 1);
        }

        return tasks;
    }

    // executeTasks 并发执行所有频道搜索任务
    private async executeTasks(tasks: ChannelTask[], keyword: string): Promise<SearchResult[]> {
        const allResults: SearchResult[] = [];
        const semaphore = new Semaphore(MaxConcurrentChannels);

        const promises = tasks.map(async (task) => {
            await semaphore.acquire();
            try {
                // 搜索单个频道（使用预先获取的guild_id）
                const results = await this.searchSingleChannel(keyword, task.Cookie, task.ChannelID, task.GuildID);
                allResults.push(...results);
            } finally {
                semaphore.release();
            }
        });

        await Promise.all(promises);
        return allResults;
    }

    // extractGuildIDFromChannelNumber 从频道号提取真实的guild_id
    private async extractGuildIDFromChannelNumber(channelNumber: string): Promise<string> {
        // 如果已经是纯数字的guild_id，直接返回
        if (/^\d+$/.test(channelNumber)) {
            return channelNumber;
        }

        // 访问频道页面获取guild_id
        const url = `https://pd.qq.com/g/${channelNumber}`;

        try {
            const response = await this.axiosInstance.get(url, {
                timeout: 10000
            });

            // 从HTML中提取guild_id
            const pattern = /https:\/\/groupprohead\.gtimg\.cn\/(\d+)\//;
            const matches = response.data.match(pattern);

            if (matches && matches.length > 1) {
                const guildID = matches[1];
                if (DebugLog) {
                    console.log(`[QQPD] 频道号 ${channelNumber} → guild_id ${guildID}`);
                }
                return guildID;
            }
        } catch (err) {
            if (DebugLog) {
                console.log(`[QQPD] 访问频道页面失败: ${err}`);
            }
        }

        if (DebugLog) {
            console.log(`[QQPD] 未能从页面提取guild_id，使用原始值: ${channelNumber}`);
        }
        return channelNumber;
    }

    // searchSingleChannel 搜索单个频道
    private async searchSingleChannel(keyword: string, cookieStr: string, channelID: string, guildID: string): Promise<SearchResult[]> {
        if (DebugLog) {
            console.log(`[QQPD] 开始搜索频道: ${channelID} (guild_id: ${guildID}), 关键词: ${keyword}`);
        }

        // 搜索前刷新cookies（更新uuid等动态字段）
        cookieStr = this.refreshCookie(cookieStr);

        // 解析Cookie
        const cookies = this.parseCookieString(cookieStr);
        const pSkey = cookies['p_skey'];
        if (!pSkey) {
            if (DebugLog) {
                console.log('[QQPD] Cookie中缺少p_skey');
            }
            return [];
        }

        // 计算bkn
        const bknValue = this.bkn(pSkey);
        const apiURL = `https://pd.qq.com/qunng/guild/gotrpc/auth/trpc.group_pro.in_guild_search_svr.InGuildSearch/NewSearch?bkn=${bknValue}`;

        if (DebugLog) {
            console.log(`[QQPD] API URL: ${apiURL}`);
            console.log(`[QQPD] bkn: ${bknValue}`);
        }

        // 构建请求payload
        const payload = {
            guild_id: guildID,
            query: keyword,
            cookie: '',
            member_cookie: '',
            search_type: {
                type: 0,
                feed_type: 0
            },
            cond: {
                channel_ids: [],
                feed_rank_type: 0,
                type_list: [2, 3]
            }
        };

        try {
            // 设置请求头
            const headers: Record<string, string> = {
                'x-oidb': `{"uint32_command":"0x9287","uint32_service_type":"2"}`,
                'content-type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': 'https://pd.qq.com/',
                'Origin': 'https://pd.qq.com',
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                'Cookie': cookieStr
            };

            // 发送请求
            const response = await this.axiosInstance.post(apiURL, payload, {
                headers,
                timeout: 15000
            });

            // 解析响应
            const apiResp = response.data;
            
            // 提取搜索结果
            const data = apiResp['data'];
            if (!data) {
                if (DebugLog) {
                    console.log('[QQPD] 响应中没有data字段');
                }
                return [];
            }

            const unionResult = data['union_result'];
            if (!unionResult) {
                if (DebugLog) {
                    console.log('[QQPD] data中没有union_result字段');
                }
                return [];
            }

            const guildFeeds = unionResult['guild_feeds'];
            if (!Array.isArray(guildFeeds)) {
                if (DebugLog) {
                    console.log('[QQPD] union_result中没有guild_feeds字段');
                }
                return [];
            }

            if (DebugLog) {
                console.log(`[QQPD] 找到 ${guildFeeds.length} 条原始结果`);
            }

            // 转换为标准格式
            const results: SearchResult[] = [];
            for (let i = 0; i < guildFeeds.length; i++) {
                const item = guildFeeds[i];
                if (typeof item === 'object' && item !== null) {
                    const result = this.extractResultInfo(item as Record<string, any>, channelID, i);
                    if (result.Title && result.Links.length > 0) {
                        results.push(result);
                    }
                }
            }

            if (DebugLog) {
                console.log(`[QQPD] 频道 ${guildID} 返回 ${results.length} 条有效结果`);
            }

            return results;
        } catch (err) {
            if (DebugLog) {
                console.log(`[QQPD] 请求失败: ${err}`);
            }
            return [];
        }
    }

    // extractResultInfo 从搜索结果中提取信息
    private extractResultInfo(item: Record<string, any>, channelID: string, index: number): SearchResult {
        // 提取标题（去掉"名称："前缀，只取第一行）
        let title = String(item['title'] || '');
        if (title.startsWith('名称：')) {
            title = title.substring('名称：'.length);
        }
        const idx = title.indexOf('\n');
        if (idx > 0) {
            title = title.substring(0, idx);
        }
        title = title.trim();

        // 从content提取网盘链接（不在插件层过滤，交给Service层处理）
        const content = String(item['content'] || '');
        const links = this.extractLinksFromContent(content);

        // 提取时间戳（从create_time字段）
        let datetime = new Date(); // 默认使用当前时间
        const createTimeStr = String(item['create_time'] || '');
        if (createTimeStr) {
            // create_time是Unix时间戳字符串，转换为Date
            const timestamp = parseInt(createTimeStr, 10);
            if (!isNaN(timestamp)) {
                datetime = new Date(timestamp * 1000);
            }
        }

        // 提取图片URL列表
        const images: string[] = [];
        const imagesInterface = item['images'];
        if (Array.isArray(imagesInterface)) {
            for (const imgItem of imagesInterface) {
                if (typeof imgItem === 'object' && imgItem !== null) {
                    const imgURL = String(imgItem['url'] || '');
                    if (imgURL) {
                        images.push(imgURL);
                    }
                }
            }
        }

        return {
            UniqueID: `qqpd-${channelID}-${index}`,
            MessageID: `qqpd-${channelID}-${index}`,
            Title: title,
            Content: content,
            Datetime: datetime,
            Tags: [],
            Links: links,
            Channel: '', // 插件搜索结果Channel必须为空
            Images: images
        };
    }

    // extractLinksFromContent 从内容中提取网盘链接（自动去重）
    private extractLinksFromContent(content: string): Link[] {
        const links: Link[] = [];
        const seen = new Set<string>();

        // 定义网盘链接正则模式
        const linkPatterns: Array<{ pattern: RegExp; linkType: string }> = [
            { pattern: /https:\/\/pan\.quark\.cn\/s\/[^\s\n]+/g, linkType: 'quark' },
            { pattern: /https:\/\/drive\.uc\.cn\/s\/[^\s\n]+/g, linkType: 'uc' },
            { pattern: /https:\/\/pan\.baidu\.com\/s\/[^\s\n?]+(?:\?pwd=[a-zA-Z0-9]+)?/g, linkType: 'baidu' },
            { pattern: /https:\/\/(?:aliyundrive\.com|www\.alipan\.com)\/s\/[^\s\n]+/g, linkType: 'aliyun' },
            { pattern: /https:\/\/pan\.xunlei\.com\/s\/[^\s\n]+/g, linkType: 'xunlei' },
            { pattern: /https:\/\/cloud\.189\.cn\/(?:t|web\/share)\/[^\s\n]+/g, linkType: 'tianyi' },
            { pattern: /https:\/\/(?:115\.com|115cdn\.com)\/s\/[^\s\n?]+(?:\?password=[a-zA-Z0-9]+)?/g, linkType: '115' },
            { pattern: /https:\/\/(?:123pan\.cn|www\.123912\.com|www\.123684\.com|www\.123685\.com|www\.123592\.com|www\.123pan\.com)\/s\/[^\s\n]+/g, linkType: '123' },
            { pattern: /https:\/\/caiyun\.(?:139\.com|feixin\.10086\.cn)\/[^\s\n]+/g, linkType: 'mobile' },
            { pattern: /https:\/\/mypikpak\.com\/s\/[^\s\n]+/g, linkType: 'pikpak' },
            { pattern: /magnet:\?xt=urn:btih:[^\n]+/g, linkType: 'magnet' },
            { pattern: /ed2k:\/\/\|file\|[^\n]+?\|\//g, linkType: 'ed2k' }
        ];

        for (const lp of linkPatterns) {
            const matches = content.match(lp.pattern) || [];

            for (const linkURL of matches) {
                // 去重检查（同一个URL只保留一次）
                if (seen.has(linkURL)) {
                    continue;
                }
                seen.add(linkURL);

                let password = '';

                // 提取密码
                if (linkURL.includes('pwd=')) {
                    const pwdRe = /pwd=([a-zA-Z0-9]+)/;
                    const pwdMatch = linkURL.match(pwdRe);
                    if (pwdMatch && pwdMatch.length > 1) {
                        password = pwdMatch[1];
                    }
                } else if (linkURL.includes('password=')) {
                    const pwdRe = /password=([a-zA-Z0-9]+)/;
                    const pwdMatch = linkURL.match(pwdRe);
                    if (pwdMatch && pwdMatch.length > 1) {
                        password = pwdMatch[1];
                    }
                }

                links.push({
                    Type: lp.linkType,
                    URL: linkURL,
                    Password: password
                });
            }
        }

        return links;
    }

    // ============ QQ登录相关 ============

    // checkQRLoginStatus 检查二维码登录状态（参考Python代码）
    private async checkQRLoginStatus(qrsig: string): Promise<LoginResult> {
        // 计算ptqrtoken
        const ptqrtoken = this.getptqrtoken(qrsig);

        // 登录检测URL
        const loginCheckURL = `https://xui.ptlogin2.qq.com/ssl/ptqrlogin?u1=https%3A%2F%2Fpd.qq.com%2Fexplore&ptqrtoken=${ptqrtoken}&ptredirect=1&h=1&t=1&g=1&from_ui=1&ptlang=2052&action=0-0-${Date.now()}&js_ver=25100115&js_type=1&login_sig=&pt_uistyle=40&aid=1600001587&daid=823&&o1vId=11f3315cde61b7b5da200e4a09fe308c&pt_js_version=28d22679`;

        try {
            const response = await this.axiosInstance.get(loginCheckURL, {
                timeout: 10000,
                headers: {
                    'Cookie': `qrsig=${qrsig}`
                }
            });

            const bodyStr = response.data;

            // 检查登录状态
            if (bodyStr.includes('二维码已失效')) {
                return { Status: 'expired', Cookie: '', QQMasked: '' };
            }

            if (bodyStr.includes('登录成功')) {
                // 提取ptsigx和uin
                const { ptsigx, uin } = await this.extractLoginInfo(bodyStr);

                // 获取完整Cookie（传递ptqrlogin返回的所有Set-Cookie）
                const setCookieHeader = response.headers['set-cookie'] || [];
                const setCookieStr = Array.isArray(setCookieHeader) ? setCookieHeader.join('; ') : setCookieHeader;

                const cookie = await this.fetchFullCookie(uin, ptsigx, setCookieStr);

                // 生成脱敏QQ号
                const qqMasked = this.maskQQ(uin);

                if (DebugLog) {
                    console.log(`[QQPD] 登录成功！QQ: ${qqMasked}, Cookie长度: ${cookie.length}, 包含keys: ${Object.keys(this.parseCookieString(cookie)).join(', ')}`);
                }

                return { Status: 'success', Cookie: cookie, QQMasked: qqMasked };
            }

            // 等待扫码
            return { Status: 'waiting', Cookie: '', QQMasked: '' };
        } catch (err) {
            throw new Error(`检查登录状态失败: ${err}`);
        }
    }

    // extractLoginInfo 从登录响应中提取ptsigx和uin
    private extractLoginInfo(responseText: string): { ptsigx: string; uin: string } {
        // 解析返回的JavaScript回调：ptuiCB('0','0','url',...)
        // 需要提取第3个参数的URL
        const start = responseText.indexOf('ptuiCB(');
        if (start === -1) {
            throw new Error('未找到ptuiCB');
        }

        // 简单解析，提取URL部分
        const re = /ptuiCB\('0','0','([^']+)'/;
        const matches = responseText.match(re);
        if (!matches || matches.length < 2) {
            throw new Error('无法解析响应');
        }

        const url = matches[1];

        // 提取ptsigx
        const ptsigxRe = /ptsigx=([A-Za-z0-9]+)/;
        const ptsigxMatches = url.match(ptsigxRe);
        if (!ptsigxMatches || ptsigxMatches.length < 2) {
            throw new Error('未找到ptsigx');
        }
        const ptsigx = ptsigxMatches[1];

        // 提取uin
        const uinRe = /uin=(\d+)/;
        const uinMatches = url.match(uinRe);
        if (!uinMatches || uinMatches.length < 2) {
            throw new Error('未找到uin');
        }
        const uin = uinMatches[1];

        return { ptsigx, uin };
    }

    // fetchFullCookie 获取完整Cookie
    private async fetchFullCookie(uin: string, ptsigx: string, setCookieHeader: string): Promise<string> {
        const checkSigURL = `https://ptlogin2.pd.qq.com/check_sig?pttype=1&uin=${uin}&service=ptqrlogin&nodirect=1&ptsigx=${ptsigx}&s_url=https%3A%2F%2Fpd.qq.com%2Fexplore&f_url=&ptlang=2052&ptredirect=101&aid=1600001587&daid=823&j_later=0&low_login_hour=0&regmaster=0&pt_login_type=3&pt_aid=0&pt_aaid=16&pt_light=0&pt_3rd_aid=0`;

        try {
            const response = await this.axiosInstance.get(checkSigURL, {
                timeout: 10000,
                headers: {
                    'Cookie': setCookieHeader
                }
            });

            // 优先使用response.headers['set-cookie']获取cookies
            const cookieDict: Record<string, string> = {};

            // 从响应头中提取cookies
            const allSetCookies = response.headers['set-cookie'] || [];
            for (const setCookie of (Array.isArray(allSetCookies) ? allSetCookies : [allSetCookies])) {
                if (setCookie) {
                    const [key, value] = this.parseSetCookieHeader(setCookie);
                    if (key && value) {
                        cookieDict[key] = value;
                    }
                }
            }

            // 手动添加uin（加上o0前缀）
            if (!cookieDict['uin'] || !cookieDict['uin'].startsWith('o')) {
                cookieDict['uin'] = 'o0' + uin;
            }

            // 转换为Cookie字符串
            const cookiePairs = Object.entries(cookieDict).map(([k, v]) => `${k}=${v}`);
            return cookiePairs.join('; ');
        } catch (err) {
            throw new Error(`获取Cookie失败: ${err}`);
        }
    }

    // parseSetCookieHeader 从Set-Cookie响应头中解析cookie（只提取名称和值，忽略属性）
    private parseSetCookieHeader(setCookie: string): [string, string] {
        // Set-Cookie格式: "name=value; Path=/; Domain=.qq.com; ..."
        // 只取第一个分号之前的部分
        const parts = setCookie.split(';');
        if (parts.length === 0) {
            return ['', ''];
        }
        
        const nameValue = parts[0].trim();
        const idx = nameValue.indexOf('=');
        if (idx <= 0) {
            return ['', ''];
        }
        
        const key = nameValue.substring(0, idx).trim();
        const value = nameValue.substring(idx + 1).trim();
        
        // 跳过cookie属性（不是真正的cookie名称）
        const skipAttrs = new Set(['Domain', 'Path', 'Expires', 'Max-Age', 'SameSite', 'Secure', 'HttpOnly']);
        if (skipAttrs.has(key)) {
            return ['', ''];
        }
        
        return [key, value];
    }

    // refreshCookie 刷新cookies（更新uuid等动态字段）
    private refreshCookie(cookieStr: string): string {
        if (!cookieStr) {
            return cookieStr;
        }

        // 解析现有cookies
        const oldCookies = this.parseCookieString(cookieStr);
        const uin = oldCookies['uin'];
        if (!uin) {
            return cookieStr;
        }

        // 去掉o0前缀
        let uinWithoutPrefix = uin;
        if (uin.startsWith('o0')) {
            uinWithoutPrefix = uin.substring(2);
        } else if (uin.startsWith('o')) {
            uinWithoutPrefix = uin.substring(1);
        }

        // 这里可以添加访问pd.qq.com获取新cookies的逻辑
        // 为了简化，暂时不实现

        return cookieStr;
    }

    // maskQQ 生成脱敏QQ号
    private maskQQ(uin: string): string {
        if (uin.length <= 4) {
            return uin;
        }
        // 前4位 + **** + 后2位
        if (uin.length > 6) {
            return uin.substring(0, 4) + '****' + uin.substring(uin.length - 2);
        }
        return uin.substring(0, 2) + '****' + uin.substring(uin.length - 2);
    }

    // generateQRCodeWithSig 生成QQ登录二维码并返回qrsig
    private async generateQRCodeWithSig(): Promise<{ qrcodeBytes: Buffer; qrsig: string }> {
        const qrcodeURL = 'https://xui.ptlogin2.qq.com/ssl/ptqrshow?appid=1600001587&e=2&l=M&s=3&d=72&v=4&t=0.3680011491059967&daid=823&pt_3rd_aid=0';

        try {
            const response = await this.axiosInstance.get(qrcodeURL, {
                timeout: 15000,
                responseType: 'arraybuffer'
            });

            if (response.status !== 200) {
                throw new Error(`二维码请求返回状态码: ${response.status}`);
            }

            // 读取二维码图片
            const qrcodeBytes = Buffer.from(response.data);

            // 提取qrsig（用于后续登录检测）
            const setCookieHeader = response.headers['set-cookie'] || [];
            const setCookieStr = Array.isArray(setCookieHeader) ? setCookieHeader.join('; ') : setCookieHeader;
            const qrsig = this.extractQrsig(setCookieStr);

            if (qrsig && DebugLog) {
                console.log(`[QQPD] 二维码生成成功，qrsig: ${qrsig.substring(0, 20)}...`);
            }

            return { qrcodeBytes, qrsig };
        } catch (err) {
            throw new Error(`生成二维码失败: ${err}`);
        }
    }

    // extractQrsig 从Set-Cookie中提取qrsig
    private extractQrsig(setCookie: string): string {
        const cookies = setCookie.split(';');
        for (const cookie of cookies) {
            const trimmedCookie = cookie.trim();
            if (trimmedCookie.startsWith('qrsig=')) {
                return trimmedCookie.substring('qrsig='.length);
            }
        }
        return '';
    }

    // getptqrtoken 计算ptqrtoken
    private getptqrtoken(qrsig: string): string {
        let e = 0;
        for (let i = 1; i <= qrsig.length; i++) {
            e += (e << 5) + qrsig.charCodeAt(i - 1);
        }
        return String(2147483647 & e);
    }

    // bkn 计算bkn值
    private bkn(skey: string): number {
        let t = 5381;
        const n = skey.length;
        for (let i = 0; i < n; i++) {
            t += (t << 5) + skey.charCodeAt(i);
        }
        return t & 2147483647;
    }

    // ============ 工具函数 ============

    // parseCookieString 解析Cookie字符串为map（用于读取保存的cookie文件）
    private parseCookieString(cookieStr: string): Record<string, string> {
        const cookies: Record<string, string> = {};
        if (!cookieStr) {
            return cookies;
        }

        const pairs = cookieStr.split(';');
        const skipAttrs = new Set(['Domain', 'Path', 'Expires', 'Max-Age', 'SameSite', 'Secure', 'HttpOnly']);

        for (const pair of pairs) {
            const trimmedPair = pair.trim();
            if (!trimmedPair) {
                continue;
            }
            const idx = trimmedPair.indexOf('=');
            if (idx > 0) {
                const key = trimmedPair.substring(0, idx).trim();
                const value = trimmedPair.substring(idx + 1).trim();
                // 跳过cookie属性（只保留真正的cookie名称）
                if (key && value && !skipAttrs.has(key)) {
                    cookies[key] = value;
                }
            }
        }

        return cookies;
    }

    // generateHash 生成hash
    private generateHash(input: string): string {
        const hash = crypto.createHash('sha256');
        hash.update(input);
        return hash.digest('hex');
    }

    // isHexString 检查是否为十六进制字符串
    private isHexString(str: string): boolean {
        return /^[0-9a-fA-F]+$/.test(str);
    }

    // normalizeChannel 规范化频道号
    private normalizeChannel(channel: string): string {
        return channel.trim();
    }

    // startCleanupTask 启动定期清理任务
    private startCleanupTask(): void {
        setInterval(() => {
            // 清理过期用户和缓存
            // 简化实现，只清理过期用户
            for (const [hash, user] of this.users.entries()) {
                if (new Date() > user.ExpireAt) {
                    user.Status = 'expired';
                    user.Cookie = '';
                    this.saveUser(user);
                }
            }
        }, 24 * 60 * 60 * 1000); // 每天清理一次
    }
}

// 信号量实现
class Semaphore {
    private count: number;
    private queue: (() => void)[];

    constructor(count: number) {
        this.count = count;
        this.queue = [];
    }

    async acquire(): Promise<void> {
        return new Promise((resolve) => {
            if (this.count > 0) {
                this.count--;
                resolve();
            } else {
                this.queue.push(resolve);
            }
        });
    }

    release(): void {
        this.count++;
        if (this.queue.length > 0) {
            const resolve = this.queue.shift();
            if (resolve) {
                resolve();
            }
        }
    }
}

// 创建并导出插件实例
export default new QQPDPlugin();