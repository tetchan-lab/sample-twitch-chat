const express = require('express');
const app = express();
const { body, validationResult } = require('express-validator');
const http = require('http').Server(app);
const io = require('socket.io')(http);
const path = require('path');
const cookieParser = require('cookie-parser');
const csrf = require('csurf');

require("dotenv").config(); // .env からクライアントIDとシークレットを読み込む
const port = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === "production";
const CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || "http://localhost:3000/auth/twitch/callback";

app.use(cookieParser()); // Cookie を扱うためのミドルウェア
app.use(express.urlencoded({ extended: true })); // フォームデータを解析するため
app.use(express.json()); // JSONデータを解析するため

// CSRF保護のミドルウェアを設定（クッキーベース）
const csrfProtection = csrf({
    cookie: {
        key: "XSRF-TOKEN",
        httpOnly: true, // JavaScript からのアクセスを禁止（XSS対策）
        secure: isProd, // 本番環境では true、開発環境では false
        sameSite: "Strict" // もしくは 'lax' を利用
    }
});

app.use(csrfProtection); // CSRF ミドルウェアを全ルートに適用

// public フォルダを静的ファイルとして提供
app.use(express.static(path.join(__dirname, 'public')));

/**=========================================================
 * ?                  リファラー設定
 * 
 *   もしリファラー設定が必要なら下のコメントアウトを外してください。
 *   example.com の箇所は自分のドメインに合わせて変更してください。
 * 
 *==========================================================
*/

/*
app.use((req, res, next) => {
    const referrer = req.get("Referer") || "";
    const allowedOrigin = /^https?:\/\/example\.com\//;

    if (!allowedOrigin.test(referrer)) {
        res.status(403).json({ error: "Forbidden", reason: "Invalid Referer" });
    } else {
        next();
    }
});
*/

// CSRFトークンを発行するエンドポイント
app.get("/csrf-token", (req, res) => {
    //console.log("🔍 CSRF トークンのリクエストが来た！"); // （デバッグ用）
    const token = req.csrfToken();
    //console.log("✅ 発行した CSRF トークン:", token); // (デバッグ用)
    res.json({ csrfToken: req.csrfToken() });
});

// ルートへのGETリクエスト
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// CSRFトークン付きのPOSTエンドポイント
app.post("/submit", 
    [
        // ① 名前フィールド (`_name`) のバリデーション
        body("name")
            .trim() // 前後の空白を削除
            .escape() // 特殊文字をエスケープ（例: <script> → `&lt;script&gt;`）
            .notEmpty().withMessage("名前を入力してください"), // 空欄を許可しない

        // ② メッセージフィールド (`_message`) のバリデーション
        body("message")
            .trim()
            .escape()
            .notEmpty().withMessage("メッセージを入力してください")
    ],
    csrfProtection,
    (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            console.log("❌ バリデーションエラー:", errors.array());
            return res.status(400).json({ errors: errors.array() });
        }

        const name = req.body.name;
        const message = req.body.message;
        console.log("✅ 受信データ（バリデーション済み）:", { name, message });

        // ここでデータベース操作などの処理を行う

        res.json({ success: true, message: "データを受け取りました！", data: { name, message } });
});

// ✅ Twitch 認証ページへリダイレクト
app.get("/auth/twitch", (req, res) => {
    const authUrl = `https://id.twitch.tv/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${REDIRECT_URI}&response_type=code&scope=user:read:email`;
    res.redirect(authUrl);
});

// ✅ Twitch からの OAuth コールバック処理
app.get("/auth/twitch/callback", async (req, res) => {
    const code = req.query.code;
    if (!code) return res.status(400).send("認証コードが見つかりません");

    try {
        // ① 認証コードをアクセストークンに変換
        const tokenResponse = await fetch("https://id.twitch.tv/oauth2/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                code,
                grant_type: "authorization_code",
                redirect_uri: REDIRECT_URI
            })
        });

        const tokenData = await tokenResponse.json();
        console.log("📝 取得したトークン:", tokenData);

        if (!tokenData.access_token || !tokenData.refresh_token) return res.status(400).send("アクセストークンまたはリフレッシュトークン取得失敗");

        const expiresAt = Date.now() + tokenData.expires_in * 1000; // 現在時刻 + 有効期限（ミリ秒）

        // ② アクセストークンと有効期限を Cookie に保存
        res.cookie("twitch_token", tokenData.access_token, { httpOnly: true, secure: isProd });
        res.cookie("twitch_expires_at", expiresAt, { httpOnly: true, secure: isProd });

        console.log(`✅ Cookie にアクセストークンを保存（有効期限: ${new Date(expiresAt)})`);

        // ③ ルート にリダイレクト
        res.redirect("/");

    } catch (error) {
        console.error(error);
        res.status(500).send("エラーが発生しました");
    }
});

let cachedUserId = null; // 🔹 `userId` を一時的に保存する変数

// ✅ Twitch ユーザー情報を取得する API
app.get("/twitch/user", async (req, res) => {
    //console.log("📢 Cookie 受信:", req.headers.cookie); // デバッグ用
    //console.log("🧐 パース後の `req.cookies`:", req.cookies); // デバッグ用

    const token = req.cookies?.twitch_token;
    const expiresAt = req.cookies?.twitch_expires_at;
    const now = Date.now();

    //console.log("🎯 取得した `twitch_token`:", token); // デバッグ用
    //console.log("🎯 取得した `twitch_expires_at`:", expiresAt); // デバッグ用
    //console.log("⏳ トークン有効期限チェック:", { now, expiresAt }); // デバッグ用

    // 日本時間で有効期限を表示する関数
    function convertToJST(expiresAt) {
        if (!expiresAt) {
            console.warn("⚠️ expiresAt がありません");
            return "データなし";
        }
    
        return new Date(Number(expiresAt)).toLocaleString("ja-JP", {
            timeZone: "Asia/Tokyo",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit"
        });
    }
    
    console.log("🕒 有効期限:", convertToJST(expiresAt));
    // 一行で有効期限を表示したい場合は ↓ を使う
    //console.log(`🕓 有効期限: ${new Date(Number(expiresAt)).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}`);

    // 🔥 未ログインたはトークンの期限切れなら `auth/twitch` にリダイレクト
    if (!token || !expiresAt || now >= expiresAt - 5 * 60 * 1000) {
        console.warn("⚠️ `twitch_token` がない or 期限切れ！ Twitch OAuth にリダイレクト！");
        return res.json({ login_url: `/auth/twitch` });
    }

    try {
        const userResponse = await fetch("https://api.twitch.tv/helix/users", {
            headers: {
                Authorization: `Bearer ${token}`,
                "Client-Id": CLIENT_ID
            }
        });

        const userData = await userResponse.json();
        console.log("🎯 取得したユーザー情報:", userData);

        if (!userData.data || userData.data.length === 0) return res.status(400).json({ error: "ユーザー情報取得失敗" });

        const user = userData.data[0];
        cachedUserId = user.id; // 🔹 `userId` を保存

        res.json({
            display_name: user.display_name,
            profile_image_url: user.profile_image_url
        });

    } catch (error) {
        console.error("❌ ユーザー情報の取得に失敗:", error);
        res.status(500).json({ error: "エラーが発生しました" });
    }
});

// ✅ 自分のtwitchエモートを取得（配信者IDが必要）
app.get("/twitch/emotes/my", async (req, res) => {
    const token = req.cookies?.twitch_token;
    const userId = "753524119"; // ここに自分の Twitch IDを使う

    try {
        const response = await fetch(`https://api.twitch.tv/helix/chat/emotes?broadcaster_id=${userId}`, {
            headers: {
                "Authorization": `Bearer ${token}`,
                "Client-Id": CLIENT_ID
            }
        });

        const data = await response.json();
        //console.log(`🎭 取得したチャンネルエモート (配信者ID: ${userId}):`, data); // デバッグ用
        res.json(data);
    } catch (error) {
        console.error(`❌ チャンネル ${userId} のエモート取得失敗:`, error);
        res.status(500).json({ error: "エモート取得に失敗しました" });
    }
});

// ✅ チャットを開いたユーザーのtwitchエモートを取得（配信者IDが必要）
app.get("/twitch/emotes/your", async (req, res) => {
    const token = req.cookies?.twitch_token;
    const userId = cachedUserId;

    try {
        const response = await fetch(`https://api.twitch.tv/helix/chat/emotes?broadcaster_id=${userId}`, {
            headers: {
                "Authorization": `Bearer ${token}`,
                "Client-Id": CLIENT_ID
            }
        });

        const data = await response.json();
        //console.log(`🎭 取得したチャンネルエモート (配信者ID: ${userId}):`, data); // デバッグ用
        res.json(data);
    } catch (error) {
        console.error(`❌ チャンネル ${userId} のエモート取得失敗:`, error);
        res.status(500).json({ error: "エモート取得に失敗しました" });
    }
});

// ✅ Twitchのグローバルエモートを取得
app.get("/twitch/emotes/global", async (req, res) => {
    try {
        const response = await fetch("https://api.twitch.tv/helix/chat/emotes/global", {
            headers: {
                "Authorization": `Bearer ${req.cookies?.twitch_token}`,
                "Client-Id": CLIENT_ID
            }
        });

        const data = await response.json();
        //console.log("🎭 取得したグローバルエモート:", data); // デバッグ用
        res.json(data);
    } catch (error) {
        console.error("❌ グローバルエモート取得失敗:", error);
        res.status(500).json({ error: "エモート取得に失敗しました" });
    }
});

// Socket.IO の設定
io.on('connection', (socket) => {
    socket.on('chat message', (msg) => {
        const user = [socket.id];
        console.log("ソケットID", user);
        console.log("📩 サーバーで受信:", msg);
        io.emit('chat message', msg);
    });
});

http.listen(port, () => {
    console.log(`Sample-Socket.IO-Chat server running on port http://localhost:${port}`);
});
