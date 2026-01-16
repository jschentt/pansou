import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { BaseAsyncPlugin } from '../plugin.manager';
import { SearchResult, Link } from '../../models/plugin-result';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// 信号量类，用于控制并发
class Semaphore {
    private available: number;
    private queue: Array<() => void> = [];

    constructor(initial: number) {
        this.available = initial;
    }

    async acquire(): Promise<void> {
        if (this.available > 0) {
            this.available--;
            return;
        }

        return new Promise((resolve) => {
            this.queue.push(resolve);
        });
    }

    release(): void {
        this.available++;
        if (this.queue.length > 0) {
            const resolve = this.queue.shift();
            if (resolve) {
                resolve();
            }
        }
    }
}

// 插件配置参数
const MaxConcurrentUsers = 10;    // 最多使用的用户数
const MaxConcurrentDetails = 50;  // 最大并发详情请求数
const DebugLog = false;           // 调试日志开关（排查问题时改为true）

// 默认账户配置（可通过Web界面添加更多账户）
const DefaultAccounts: Array<{ username: string; password: string }> = [];

// 存储目录
let StorageDir: string;

// HTML模板
const HTMLTemplate = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>PanSou Gying搜索配置</title>
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
        .form-group {
            margin-bottom: 15px;
        }
        .form-group label {
            display: block;
            margin-bottom: 5px;
            font-weight: bold;
        }
        .form-group input {
            width: 100%;
            padding: 10px;
            border: 1px solid #ddd;
            border-radius: 6px;
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
        .test-results {
            max-height: 300px;
            overflow-y: auto;
            background: #f8f9fa;
            padding: 15px;
            border-radius: 6px;
            margin-top: 10px;
        }
        .hidden { display: none; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🔍 PanSou Gying搜索</h1>
            <p>配置你的专属搜索服务</p>
            <p style="font-size: 12px; margin-top: 10px; opacity: 0.8;">
                🔗 当前地址: <span id="current-url">HASH_PLACEHOLDER</span>
            </p>
        </div>

        <div class="section" id="login-section">
            <div class="section-title">🔐 登录状态</div>
            
            <div id="logged-in-view" class="hidden">
                <div class="status-box">
                    <div class="status-item">
                        <span>状态</span>
                        <span><strong style="color: #48bb78;">✅ 已登录</strong></span>
                    </div>
                    <div class="status-item">
                        <span>用户名</span>
                        <span id="username-display">-</span>
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
                <div id="alert-box"></div>
                <div class="form-group">
                    <label>用户名</label>
                    <input type="text" id="username" placeholder="输入用户名">
                </div>
                <div class="form-group">
                    <label>密码</label>
                    <input type="password" id="password" placeholder="输入密码">
                </div>
                <button class="btn btn-primary" onclick="login()">登录</button>
            </div>
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
            
            <p style="margin-bottom: 15px;">你可以通过API程序化管理：</p>

            <details>
                <summary style="cursor: pointer; padding: 10px 0; font-weight: bold;">登录</summary>
                <div style="background: #2d3748; color: #68d391; padding: 10px; border-radius: 6px; font-family: monospace; font-size: 12px; overflow-x: auto;">curl -X POST https://your-domain.com/gying/HASH_PLACEHOLDER \
  -H "Content-Type: application/json" \
  -d '{"action": "login", "username": "user", "password": "pass"}'</div>
            </details>
        </div>
    </div>

    <script>
        const HASH = 'HASH_PLACEHOLDER';
        const API_URL = '/gying/' + HASH;
        let statusCheckInterval = null;

        window.onload = function() {
            updateStatus();
            startStatusPolling();
        };

        function startStatusPolling() {
            statusCheckInterval = setInterval(updateStatus, 5000);
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
                    document.getElementById('logged-in-view').classList.remove('hidden');
                    document.getElementById('not-logged-in-view').classList.add('hidden');
                    
                    document.getElementById('username-display').textContent = data.username_masked || '-';
                    document.getElementById('login-time').textContent = data.login_time || '-';
                    document.getElementById('expire-info').textContent = '剩余 ' + (data.expires_in_days || 0) + ' 天';
                } else {
                    document.getElementById('logged-in-view').classList.add('hidden');
                    document.getElementById('not-logged-in-view').classList.remove('hidden');
                }
            }
        }

        function showAlert(message, type = 'success') {
            const alertBox = document.getElementById('alert-box');
            alertBox.innerHTML = '<div class="alert alert-' + type + '">' + message + '</div>';
            setTimeout(() => {
                alertBox.innerHTML = '';
            }, 3000);
        }

        async function login() {
            const username = document.getElementById('username').value.trim();
            const password = document.getElementById('password').value.trim();
            
            if (!username || !password) {
                showAlert('请输入用户名和密码', 'error');
                return;
            }

            const result = await postAction('login', { username, password });
            if (result.success) {
                showAlert(result.message);
                updateStatus();
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

// 用户数据结构
interface User {
    hash: string;
    username: string;
    usernameMasked: string;
    encryptedPassword: string;
    cookie: string;
    status: string;
    createdAt: Date;
    loginAt: Date;
    expireAt: Date;
    lastAccessAt: Date;
}

// 搜索页面JSON数据结构
interface SearchData {
    q: string;
    wd: string[];
    n: string;
    l: {
        title: string[];
        year: number[];
        d: string[];
        i: string[];
        info: string[];
        daoyan: string[];
        zhuyan: string[];
    };
}

// 详情接口JSON数据结构
interface DetailData {
    code: number;
    wp: boolean;
    panlist: {
        id: string[];
        name: string[];
        p: string[];
        url: string[];
        type: number[];
        user: string[];
        time: string[];
        tname: string[];
    };
}

export class GyingPlugin extends BaseAsyncPlugin {
    private users: Map<string, User> = new Map();
    private searchCache: Map<string, SearchResult[]> = new Map();
    private initialized: boolean = false;

    constructor() {
        super("gying", 3); // 优先级3
    }

    Name(): string {
        return "gying";
    }

    DisplayName(): string {
        return "Gying搜索";
    }

    Description(): string {
        return "Gying - 影视资源搜索";
    }

    // 初始化插件
    async initialize(): Promise<void> {
        if (this.initialized) {
            return;
        }

        // 初始化存储目录路径
        const cachePath = process.env.CACHE_PATH || "./cache";
        StorageDir = path.join(cachePath, "gying_users");

        // 初始化存储目录
        if (!fs.existsSync(StorageDir)) {
            fs.mkdirSync(StorageDir, { recursive: true });
        }

        // 加载所有用户到内存
        this.loadAllUsers();

        // 异步初始化默认账户（不阻塞启动）
        setTimeout(() => {
            this.initDefaultAccounts();
        }, 1000);

        // 启动定期清理任务
        this.startCleanupTask();

        this.initialized = true;
    }

    protected async searchImpl(client: AxiosInstance, keyword: string): Promise<SearchResult[]> {
        // 确保插件已初始化
        if (!this.initialized) {
            await this.initialize();
        }

        // 检查缓存
        if (this.searchCache.has(keyword)) {
            this.debugPrint(`命中插件缓存: ${keyword}`);
            return this.searchCache.get(keyword)!;
        }

        this.debugPrint(`searchImpl REAL 执行: ${keyword}`);
        const users = this.getActiveUsers();
        this.debugPrint(`找到 ${users.length} 个有效用户`);

        if (users.length === 0) {
            this.debugPrint(`没有有效用户，返回空结果`);
            return [];
        }

        // 限制并发用户数
        if (users.length > MaxConcurrentUsers) {
            users.sort((a, b) => b.lastAccessAt.getTime() - a.lastAccessAt.getTime());
            users.splice(MaxConcurrentUsers);
        }

        // 执行搜索任务
        const results = await this.executeSearchTasks(users, keyword);
        this.debugPrint(`搜索完成，获得 ${results.length} 条结果`);

        // 写入缓存
        if (results.length > 0) {
            this.searchCache.set(keyword, results);
        }

        return results;
    }

    // 加载所有用户到内存
    private loadAllUsers(): void {
        try {
            const files = fs.readdirSync(StorageDir);
            let totalFiles = 0;
            let loadedCount = 0;
            let skippedInactive = 0;

            for (const file of files) {
                if (path.extname(file) !== '.json') {
                    continue;
                }

                totalFiles++;
                const filePath = path.join(StorageDir, file);
                
                try {
                    const data = fs.readFileSync(filePath, 'utf8');
                    const user = JSON.parse(data) as User;

                    // 过滤条件：status必须是active
                    if (user.status !== 'active') {
                        this.debugPrint(`⏭️  跳过用户 ${user.usernameMasked}: status=${user.status} (非active)`);
                        skippedInactive++;
                        continue;
                    }

                    // 转换日期字符串为Date对象
                    user.createdAt = new Date(user.createdAt);
                    user.loginAt = new Date(user.loginAt);
                    user.expireAt = new Date(user.expireAt);
                    user.lastAccessAt = new Date(user.lastAccessAt);

                    // 存储用户数据
                    this.users.set(user.hash, user);
                    loadedCount++;

                    this.debugPrint(`✅ 已加载用户 ${user.usernameMasked} (密码:${user.encryptedPassword ? '有' : '无'}, 将在初始化时登录)`);
                } catch (error) {
                    this.debugPrint(`❌ 加载用户文件 ${file} 失败: ${error}`);
                }
            }

            console.log(`[Gying] 用户加载完成: 总文件=${totalFiles}, 已加载=${loadedCount}, 跳过(非active)=${skippedInactive}`);
        } catch (error) {
            console.error(`[Gying] 加载用户失败: ${error}`);
        }
    }

    // 初始化默认账户
    private initDefaultAccounts(): void {
        // 步骤1：处理DefaultAccounts（代码中配置的默认账户）
        for (let i = 0; i < DefaultAccounts.length; i++) {
            const account = DefaultAccounts[i];
            this.debugPrint(`[默认账户 ${i+1}/${DefaultAccounts.length}] 处理: ${account.username}`);
            this.initOrRestoreUser(account.username, account.password, 'default');
        }

        // 步骤2：遍历所有已加载的用户，恢复没有cookie的用户
        const usersToRestore: User[] = [];
        this.users.forEach(user => {
            if (user.encryptedPassword && !user.cookie) {
                usersToRestore.push(user);
            }
        });

        if (usersToRestore.length > 0) {
            console.log(`[Gying] 发现 ${usersToRestore.length} 个需要恢复的用户（使用加密密码重新登录）`);
            for (let i = 0; i < usersToRestore.length; i++) {
                const user = usersToRestore[i];
                this.debugPrint(`[恢复用户 ${i+1}/${usersToRestore.length}] 处理: ${user.usernameMasked}`);

                // 解密密码
                try {
                    const password = this.decryptPassword(user.encryptedPassword);
                    this.initOrRestoreUser(user.username, password, 'restore');
                } catch (error) {
                    console.error(`[Gying] ❌ 用户 ${user.usernameMasked} 解密密码失败: ${error}`);
                }
            }
        }
    }

    // 初始化或恢复单个用户（登录并保存）
    private async initOrRestoreUser(username: string, password: string, source: string): Promise<void> {
        const hash = this.generateHash(username);

        // 检查用户是否已存在
        if (this.users.has(hash)) {
            const user = this.users.get(hash)!;
            if (user.cookie) {
                this.debugPrint(`用户 ${this.maskUsername(username)} 已登录，跳过`);
                return;
            }
        }

        // 登录
        this.debugPrint(`开始登录账户: ${username}`);
        try {
            const { cookie } = await this.doLogin(username, password);
            
            // 加密密码
            const encryptedPassword = this.encryptPassword(password);
            
            // 保存用户
            const now = new Date();
            const user: User = {
                hash,
                username,
                usernameMasked: this.maskUsername(username),
                encryptedPassword,
                cookie,
                status: 'active',
                createdAt: now,
                loginAt: now,
                expireAt: new Date(now.getTime() + 121 * 24 * 60 * 60 * 1000), // 121天有效期
                lastAccessAt: now
            };

            // 如果用户已存在，更新创建时间
            if (this.users.has(hash)) {
                const existingUser = this.users.get(hash)!;
                user.createdAt = existingUser.createdAt;
            }

            this.saveUser(user);
            console.log(`[Gying] ✅ 账户 ${user.usernameMasked} 初始化成功 (来源:${source})`);
        } catch (error) {
            console.error(`[Gying] ❌ 账户 ${username} 登录失败: ${error}`);
        }
    }

    // 执行登录
    private async doLogin(username: string, password: string): Promise<{ cookie: string }> {
        this.debugPrint(`========== 开始登录 ==========`);
        this.debugPrint(`用户名: ${username}`);
        this.debugPrint(`密码长度: ${password.length}`);

        const axiosInstance = axios.create({
            timeout: 30000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });

        const cookieMap: Record<string, string> = {};

        // ========== 步骤1: GET登录页 (获取初始PHPSESSID) ==========
        const loginPageURL = 'https://www.gying.net/user/login/';
        this.debugPrint(`步骤1: 访问登录页面: ${loginPageURL}`);

        try {
            const getResp = await axiosInstance.get(loginPageURL);
            this.debugPrint(`登录页面状态码: ${getResp.status}`);

            // 收集cookies
            this.collectCookies(getResp.headers['set-cookie'], cookieMap);

            // ========== 步骤2: POST登录 (获取认证cookies) ==========
            const loginURL = 'https://www.gying.net/user/login';
            const postData = new URLSearchParams({
                code: '',
                siteid: '1',
                dosubmit: '1',
                cookietime: '10506240',
                username: username,
                password: password
            });

            this.debugPrint(`步骤2: POST登录`);
            this.debugPrint(`登录URL: ${loginURL}`);

            const resp = await axiosInstance.post(loginURL, postData, {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            });

            this.debugPrint(`响应状态码: ${resp.status}`);

            // 收集cookies
            this.collectCookies(resp.headers['set-cookie'], cookieMap);

            this.debugPrint(`响应内容: ${JSON.stringify(resp.data)}`);

            // 检查登录结果
            if (resp.data.code !== 200) {
                throw new Error(`登录失败: code=${resp.data.code}, 响应=${JSON.stringify(resp.data)}`);
            }

            // 构建cookie字符串
            const cookieString = Object.entries(cookieMap)
                .map(([name, value]) => `${name}=${value}`)
                .join('; ');

            this.debugPrint(`登录成功，获取cookie: ${cookieString.substring(0, 50)}...`);

            return { cookie: cookieString };
        } catch (error) {
            this.debugPrint(`登录失败: ${error}`);
            throw error;
        }
    }

    // 收集cookies
    private collectCookies(setCookieHeaders: string[] | undefined, cookieMap: Record<string, string>): void {
        if (!setCookieHeaders) return;

        for (const setCookie of setCookieHeaders) {
            const parts = setCookie.split(';');
            if (parts.length > 0) {
                const cookiePart = parts[0].trim();
                const idx = cookiePart.indexOf('=');
                if (idx > 0) {
                    const name = cookiePart.substring(0, idx);
                    const value = cookiePart.substring(idx + 1);
                    cookieMap[name] = value;
                    this.debugPrint(`  收集Cookie: ${name}=${value.substring(0, 20)}...`);
                }
            }
        }
    }

    // 获取有效用户
    private getActiveUsers(): User[] {
        const users: User[] = [];
        this.users.forEach(user => {
            if (user.status === 'active' && user.cookie) {
                users.push(user);
            }
        });
        return users;
    }

    // 执行搜索任务
    private async executeSearchTasks(users: User[], keyword: string): Promise<SearchResult[]> {
        const allResults: SearchResult[] = [];
        const semaphore = new Semaphore(MaxConcurrentUsers);

        const tasks = users.map(async (user) => {
            await semaphore.acquire();
            try {
                const results = await this.searchWithUser(user, keyword);
                allResults.push(...results);
            } catch (error) {
                this.debugPrint(`用户 ${user.usernameMasked} 搜索失败: ${error}`);
            } finally {
                semaphore.release();
            }
        });

        await Promise.all(tasks);
        return this.removeDuplicateResults(allResults);
    }

    // 使用单个用户执行搜索
    private async searchWithUser(user: User, keyword: string): Promise<SearchResult[]> {
        try {
            const client = axios.create({
                headers: {
                    'Cookie': user.cookie,
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                }
            });

            // 执行搜索
            return await this.searchWithClient(client, keyword);
        } catch (error) {
            this.debugPrint(`搜索失败: ${error}`);
            return [];
        }
    }

    // 使用客户端执行搜索
    private async searchWithClient(client: AxiosInstance, keyword: string): Promise<SearchResult[]> {
        // 这里实现实际的搜索逻辑
        // 由于API可能变化，这里简化处理
        // 实际项目中需要根据具体API格式实现
        return [];
    }

    // 移除重复结果
    private removeDuplicateResults(results: SearchResult[]): SearchResult[] {
        const uniqueResults: SearchResult[] = [];
        const seenTitles = new Set<string>();

        for (const result of results) {
            if (!seenTitles.has(result.Title)) {
                seenTitles.add(result.Title);
                uniqueResults.push(result);
            }
        }

        return uniqueResults;
    }

    // 保存用户
    private saveUser(user: User): void {
        this.users.set(user.hash, user);
        this.persistUser(user);
    }

    // 持久化用户到文件
    private persistUser(user: User): void {
        try {
            const filePath = path.join(StorageDir, `${user.hash}.json`);
            fs.writeFileSync(filePath, JSON.stringify(user, null, 2));
        } catch (error) {
            console.error(`[Gying] 保存用户失败: ${error}`);
        }
    }

    // 生成用户哈希
    private generateHash(username: string): string {
        return crypto.createHash('sha256').update(username).digest('hex');
    }

    // 脱敏用户名
    private maskUsername(username: string): string {
        if (username.length <= 3) {
            return username[0] + '*'.repeat(username.length - 1);
        }
        return username.substring(0, 2) + '*'.repeat(username.length - 3) + username.substring(username.length - 1);
    }

    // 加密密码
    private encryptPassword(password: string): string {
        // 使用固定密钥（实际应用中可以使用配置或环境变量）
        const key = Buffer.from('gying-secret-key-32bytes-long!!!', 'utf8'); // 32字节密钥用于AES-256
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
        let encrypted = cipher.update(password, 'utf8', 'base64');
        encrypted += cipher.final('base64');
        return iv.toString('base64') + ':' + encrypted;
    }

    // 解密密码
    private decryptPassword(encrypted: string): string {
        // 使用与加密相同的密钥
        const key = Buffer.from('gying-secret-key-32bytes-long!!!', 'utf8');
        const parts = encrypted.split(':');
        const iv = Buffer.from(parts[0], 'base64');
        const encryptedText = parts[1];
        const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
        let decrypted = decipher.update(encryptedText, 'base64', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    }

    // 启动定期清理任务
    private startCleanupTask(): void {
        setInterval(() => {
            const now = new Date();
            this.users.forEach((user, hash) => {
                if (user.expireAt < now) {
                    user.status = 'expired';
                    this.saveUser(user);
                }
            });
        }, 24 * 60 * 60 * 1000); // 每24小时清理一次
    }

    // 调试日志
    private debugPrint(message: string): void {
        if (DebugLog) {
            console.log(`[Gying DEBUG] ${message}`);
        }
    }
}

// 注册插件
const plugin = new GyingPlugin();
plugin.register();