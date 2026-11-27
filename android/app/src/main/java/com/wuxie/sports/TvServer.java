package com.wuxie.sports;

import android.content.Context;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Collections;
import java.util.Date;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 电视端内置的小型数据服务（纯 Java，无第三方依赖）。
 *
 * 页面在 APK 里用 file:///android_asset/index.html 打开，数据全部请求
 * http://127.0.0.1:8099/api/*，由本机直接去上游抓取 / 解析 / 转发，
 * 不再依赖电脑上的 server/dev-server.mjs。
 *
 * 接口与 Node 版保持一致：replays / replay / lives / live / rank / schedule / hls。
 */
public class TvServer {

    public static final int DEFAULT_PORT = 8099;

    private static final String SITE = "https://www.doubaozhibo.com";
    private static final String QQ = "https://matchweb.sports.qq.com";
    private static final String JRKAN = "https://www.jrkan77.com";
    private static final String NBA_ID = "100000";
    // 科比页远程数据：jsDelivr 主线路，raw GitHub 备用
    private static final String[] KOBE_DATA_URLS = {
            "https://cdn.jsdelivr.net/gh/crazyxiang/liwuxie_sports@main/app/web/assets/data/kobe.json",
            "https://raw.githubusercontent.com/crazyxiang/liwuxie_sports/main/app/web/assets/data/kobe.json"
    };
    private static final String UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            + "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

    /**
     * 致敬曼巴打卡墙：电视端不做本地存储，全部转发到线上同一份后端，
     * 这样电脑、手机、电视看到的是同一份数据。可用 -D 参数或代码改这里换地址。
     */
    public static String TRIBUTE_CLOUD = "https://37losonelorqwuwhzj1.traesite.cn";

    private static final long TTL_FOREVER = -1L;
    private static final long TTL_REPLAY = -2L;
    private static final long TTL_DAY = -3L;

    private static final long ALLOW_TTL = 2 * 60 * 60 * 1000L;
    private static final int ALLOW_MAX = 30000;
    private static final Map<String, Long> ALLOWED = Collections.synchronizedMap(
            new LinkedHashMap<String, Long>() {
                @Override
                protected boolean removeEldestEntry(Map.Entry<String, Long> eldest) {
                    return size() > ALLOW_MAX;
                }
            });

    private static class CacheEntry {
        final long at;
        final Object value;

        CacheEntry(long at, Object value) {
            this.at = at;
            this.value = value;
        }
    }

    private static final Map<String, CacheEntry> CACHE = new HashMap<String, CacheEntry>();
    private static final Object CACHE_LOCK = new Object();

    private interface Loader {
        Object load() throws Exception;
    }

    private final int port;
    private final Context context;
    private ServerSocket serverSocket;

    public TvServer(int port) {
        this(port, null);
    }

    public TvServer(int port, Context context) {
        this.port = port;
        this.context = context;
    }

    public void start() {
        Thread t = new Thread(new Runnable() {
            @Override
            public void run() {
                loop();
            }
        }, "wuxie-tv-server");
        t.setDaemon(true);
        t.start();
    }

    public void stop() {
        try {
            if (serverSocket != null) serverSocket.close();
        } catch (IOException ignored) {
        }
    }

    private void loop() {
        try {
            serverSocket = new ServerSocket(port, 50, InetAddress.getByName("127.0.0.1"));
            serverSocket.setReuseAddress(true);
        } catch (IOException e) {
            return;
        }
        while (true) {
            try {
                final Socket socket = serverSocket.accept();
                Thread worker = new Thread(new Runnable() {
                    @Override
                    public void run() {
                        handle(socket);
                    }
                }, "wuxie-http");
                worker.setDaemon(true);
                worker.start();
            } catch (IOException e) {
                if (serverSocket == null || serverSocket.isClosed()) return;
            }
        }
    }

    // ---------------- HTTP ----------------

    private static class Response {
        int status;
        String type;
        byte[] body;
        String cacheControl;

        Response(int status, String type, byte[] body, String cacheControl) {
            this.status = status;
            this.type = type;
            this.body = body;
            this.cacheControl = cacheControl;
        }
    }

    private void handle(Socket socket) {
        try (Socket s = socket) {
            s.setSoTimeout(30000);
            BufferedReader in = new BufferedReader(
                    new InputStreamReader(s.getInputStream(), StandardCharsets.UTF_8));
            String requestLine = in.readLine();
            if (requestLine == null) return;
            String rangeHeader = null;
            String header;
            while ((header = in.readLine()) != null && !header.isEmpty()) {
                int colon = header.indexOf(':');
                if (colon > 0 && header.substring(0, colon).trim().equalsIgnoreCase("Range")) {
                    rangeHeader = header.substring(colon + 1).trim();
                }
            }

            String[] parts = requestLine.split(" ");
            if (parts.length < 2) return;
            String path = parts[1];
            String query = "";
            int q = path.indexOf('?');
            if (q >= 0) {
                query = path.substring(q + 1);
                path = path.substring(0, q);
            }

            Map<String, String> qs = parseQuery(query);
            String method = parts[0] == null ? "GET" : parts[0].toUpperCase(java.util.Locale.ROOT);
            if (path.equals("/api/bili/video")) {
                // 视频要支持 Range 流式转发，不能整段读进内存
                streamBiliVideo(s.getOutputStream(), qs.get("bv"), rangeHeader);
                return;
            }
            if (path.startsWith("/api/tribute")) {
                // 统一走线上后端，保证电视和电脑是同一份打卡数据
                write(s.getOutputStream(), proxyTribute(path, query, "POST".equals(method)));
                return;
            }
            Response res;
            if (path.startsWith("/api/")) {
                res = route(path, qs);
            } else if (path.equals("/") || path.equals("/health")) {
                res = json(200, map("ok", true));
            } else {
                res = json(404, map("error", "接口不存在"));
            }
            write(s.getOutputStream(), res);
        } catch (Exception ignored) {
            // 单个连接失败不影响服务
        }
    }

    private void write(OutputStream out, Response res) throws IOException {
        StringBuilder head = new StringBuilder();
        head.append("HTTP/1.1 ").append(res.status).append(' ').append(statusText(res.status)).append("\r\n");
        head.append("Content-Type: ").append(res.type).append("\r\n");
        head.append("Content-Length: ").append(res.body.length).append("\r\n");
        head.append("Access-Control-Allow-Origin: *\r\n");
        head.append("Cache-Control: ").append(res.cacheControl == null ? "no-store" : res.cacheControl).append("\r\n");
        head.append("Connection: close\r\n\r\n");
        out.write(head.toString().getBytes(StandardCharsets.UTF_8));
        out.write(res.body);
        out.flush();
    }

    /**
     * 把 /api/tribute、/api/tribute/stats 原样转发到线上，读和写都走云端同一份存储。
     */
    private Response proxyTribute(String path, String query, boolean post) {
        HttpURLConnection conn = null;
        try {
            String target = TRIBUTE_CLOUD + path + (query == null || query.isEmpty() ? "" : "?" + query);
            conn = (HttpURLConnection) new URL(target).openConnection();
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(15000);
            conn.setInstanceFollowRedirects(false);
            conn.setRequestProperty("User-Agent", UA);
            conn.setRequestProperty("Accept", "application/json");
            if (post) {
                conn.setRequestMethod("POST");
                conn.setDoOutput(true);
                // 设备号在 query 里，body 只要是个合法 JSON 即可
                byte[] body = "{}".getBytes(StandardCharsets.UTF_8);
                conn.setFixedLengthStreamingMode(body.length);
                OutputStream os = conn.getOutputStream();
                os.write(body);
                os.flush();
                os.close();
            }
            int code = conn.getResponseCode();
            InputStream is = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            if (is != null) {
                byte[] chunk = new byte[4096];
                int n;
                while ((n = is.read(chunk)) > 0) buffer.write(chunk, 0, n);
                is.close();
            }
            byte[] data = buffer.toByteArray();
            if (data.length == 0) {
                data = ("{\"error\":\"云端无返回\",\"status\":" + code + "}")
                        .getBytes(StandardCharsets.UTF_8);
            }
            return new Response(code, "application/json; charset=utf-8", data, "no-store");
        } catch (Exception e) {
            return json(502, map("error", "致敬墙暂时连不上云端，稍后再试",
                    "detail", String.valueOf(e.getMessage())));
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static String statusText(int code) {        switch (code) {
            case 200: return "OK";
            case 206: return "Partial Content";
            case 400: return "Bad Request";
            case 403: return "Forbidden";
            case 404: return "Not Found";
            case 502: return "Bad Gateway";
            default: return "OK";
        }
    }

    private static Map<String, String> parseQuery(String query) {
        Map<String, String> out = new HashMap<String, String>();
        if (query == null || query.isEmpty()) return out;
        for (String pair : query.split("&")) {
            int eq = pair.indexOf('=');
            try {
                if (eq < 0) {
                    out.put(URLDecoder.decode(pair, "UTF-8"), "");
                } else {
                    out.put(URLDecoder.decode(pair.substring(0, eq), "UTF-8"),
                            URLDecoder.decode(pair.substring(eq + 1), "UTF-8"));
                }
            } catch (Exception ignored) {
            }
        }
        return out;
    }

    // ---------------- 路由 ----------------

    private Response route(String path, Map<String, String> qs) {
        try {
            if (path.equals("/api/replays")) return apiReplays(qs);
            if (path.equals("/api/lives")) return apiLives(qs);
            if (path.equals("/api/live")) return apiLive(qs);
            if (path.equals("/api/rank")) return apiRank(qs);
            if (path.equals("/api/schedule")) return apiSchedule(qs);
            if (path.equals("/api/replay")) return apiReplay(qs);
            if (path.equals("/api/hls")) return apiHls(qs);
            if (path.equals("/api/bili/cover")) return apiBiliCover(qs);
            if (path.equals("/api/bili/view")) return apiBiliView(qs);
            if (path.equals("/api/kobe")) return apiKobe(qs);
            return json(404, map("error", "接口不存在"));
        } catch (Exception e) {
            return json(502, map("error", "请求失败", "detail", String.valueOf(e.getMessage())));
        }
    }

    // ---------------- 科比页远程数据 ----------------

    private static boolean kobeJsonValid(String s) {
        return s != null && s.length() > 40
                && s.trim().startsWith("{")
                && s.contains("\"videoGroups\"")
                && s.contains("\"version\"");
    }

    private static int kobeVersion(String s) {
        if (s == null) return -1;
        Matcher m = Pattern.compile("\"version\"\\s*:\\s*(\\d+)").matcher(s);
        return m.find() ? Integer.parseInt(m.group(1)) : 0;
    }

    private static String kobeUpdatedAt(String s) {
        if (s == null) return "";
        Matcher m = Pattern.compile("\"updatedAt\"\\s*:\\s*\"([^\"]+)\"").matcher(s);
        return m.find() ? m.group(1) : "";
    }

    /** 远端数据是否比 base 新；版本号优先，版本相同再比 updatedAt */
    private static boolean kobeNewer(String next, String base) {
        if (next == null || !kobeJsonValid(next)) return false;
        if (base == null || !kobeJsonValid(base)) return true;
        int nv = kobeVersion(next);
        int bv = kobeVersion(base);
        if (nv != bv) return nv > bv;
        return kobeUpdatedAt(next).compareTo(kobeUpdatedAt(base)) > 0;
    }

    private Response apiKobe(Map<String, String> qs) {
        boolean force = "1".equals(qs.get("refresh"));
        File cacheFile = context == null ? null : new File(context.getFilesDir(), "kobe-cache.json");
        String asset = readKobeAsset();
        String cached = cacheFile != null && cacheFile.isFile() ? readText(cacheFile) : null;
        String base = kobeNewer(asset, cached) ? asset : cached;

        if (!force && kobeJsonValid(cached) && !kobeNewer(asset, cached)) {
            // 缓存过期就后台更新，页面先用旧数据，避免首屏等网络
            if (System.currentTimeMillis() - cacheFile.lastModified() > 30 * 60 * 1000L) {
                refreshKobeInBackground(cacheFile);
            }
            return rawJson(cached);
        }

        if (force) {
            String remote = fetchKobeRemote();
            if (remote != null && kobeVersion(remote) >= kobeVersion(base)) {
                if (cacheFile != null) writeText(cacheFile, remote);
                return rawJson(remote);
            }
        }

        // 远端不可达时用 APK 里打包的数据，保证离线也能看
        if (kobeJsonValid(asset)) {
            if (cacheFile != null) writeText(cacheFile, asset);
            // 先把页面点亮，再去后台拉最新版本
            refreshKobeInBackground(cacheFile);
            return rawJson(asset);
        }

        if (kobeJsonValid(cached)) return rawJson(cached);
        return json(502, map("error", "科比数据不可用"));
    }

    /** 两条线路都拉，选版本号最大的，避免 CDN 旧缓存盖掉 GitHub 新数据 */
    private static String fetchKobeRemote() {
        String best = null;
        for (String target : KOBE_DATA_URLS) {
            try {
                String body = fetchKobeText(target);
                if (kobeJsonValid(body) && (best == null || kobeNewer(body, best))) best = body;
            } catch (Exception ignored) {
                // 换下一条线路
            }
        }
        return best;
    }

    private static volatile boolean KOBE_REFRESHING = false;

    private void refreshKobeInBackground(final File cacheFile) {
        if (cacheFile == null || KOBE_REFRESHING) return;
        KOBE_REFRESHING = true;
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    String current = readText(cacheFile);
                    String remote = fetchKobeRemote();
                    if (remote != null && kobeNewer(remote, current)) writeText(cacheFile, remote);
                } finally {
                    KOBE_REFRESHING = false;
                }
            }
        }, "kobe-refresh").start();
    }

    private String readKobeAsset() {
        try {
            if (context == null) return "";
            InputStream is = context.getAssets().open("assets/data/kobe.json");
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = is.read(buf)) > 0) out.write(buf, 0, n);
            is.close();
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        } catch (Exception ignored) {
            return "";
        }
    }

    private static String fetchKobeText(String target) throws IOException {
        HttpURLConnection conn = (HttpURLConnection) new URL(target).openConnection();
        conn.setConnectTimeout(2500);
        conn.setReadTimeout(3000);
        conn.setInstanceFollowRedirects(true);
        conn.setRequestProperty("User-Agent", UA);
        conn.setRequestProperty("Cache-Control", "no-cache");
        int code = conn.getResponseCode();
        if (code != 200) {
            conn.disconnect();
            throw new IOException("HTTP " + code);
        }
        InputStream is = conn.getInputStream();
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = is.read(buf)) > 0) out.write(buf, 0, n);
        is.close();
        conn.disconnect();
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }

    private static String readText(File file) {
        try {
            FileInputStream in = new FileInputStream(file);
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            in.close();
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        } catch (Exception e) {
            return "";
        }
    }

    private static void writeText(File file, String text) {
        try {
            FileOutputStream out = new FileOutputStream(file);
            out.write(text.getBytes(StandardCharsets.UTF_8));
            out.close();
        } catch (Exception ignored) {
        }
    }

    private Response apiReplays(Map<String, String> qs) {
        String category = qs.containsKey("category") ? qs.get("category") : "basketball";
        if (!"basketball".equals(category) && !"football".equals(category)) {
            return json(400, map("error", "不支持的分类"));
        }
        int page = 1;
        try {
            page = Math.max(1, Integer.parseInt(qs.containsKey("page") ? qs.get("page") : "1"));
        } catch (Exception ignored) {
        }
        final String cat = category;
        final int pg = page;
        final boolean force = "1".equals(qs.get("refresh"));
        try {
            final Map<String, Object> data = new LinkedHashMap<String, Object>();
            String key = "list:" + category + ":" + page;
            Object value = cached(key, new Loader() {
                @Override
                public Object load() throws Exception {
                    String html = fetchText(SITE + "/replays?category=" + cat + "&page=" + pg, null);
                    Map<String, Object> parsed = parseList(html);
                    List<Object> items = new ArrayList<Object>();
                    Object raw = parsed.get("items");
                    if (raw instanceof List) {
                        for (Object it : (List<?>) raw) {
                            if (it instanceof Map && "NBA".equals(((Map<?, ?>) it).get("league"))) {
                                items.add(it);
                            }
                        }
                    }
                    parsed.put("items", items);
                    parsed.put("category", cat);
                    return parsed;
                }
            }, TTL_REPLAY, force);
            if (value instanceof Map) data.putAll((Map<String, Object>) value);
            long at = cachedAt(key);
            data.put("updatedAt", at > 0 ? at : System.currentTimeMillis());
            return json(200, data);
        } catch (Exception e) {
            return json(502, map("error", "抓取失败", "detail", msg(e)));
        }
    }

    private Response apiLives(Map<String, String> qs) {
        final boolean force = "1".equals(qs.get("refresh"));
        try {
            Object value = cached("lives", new Loader() {
                @Override
                public Object load() throws Exception {
                    return fetchLives();
                }
            }, 60 * 1000L, force);
            Map<String, Object> data = new LinkedHashMap<String, Object>();
            if (value instanceof Map) data.putAll((Map<String, Object>) value);
            // 默认只回篮球，老版本 APK 行为不变；sport=all 前端一次拿全量
            String sport = qs.containsKey("sport") ? qs.get("sport") : "basketball";
            List<Object> kept = new ArrayList<Object>();
            Object raw = data.get("items");
            if (raw instanceof List) {
                for (Object o : (List<Object>) raw) {
                    if (!(o instanceof Map)) continue;
                    Map<String, Object> it = (Map<String, Object>) o;
                    Object s = it.get("sport");
                    String si = s == null ? "basketball" : String.valueOf(s);
                    if (!"basketball".equals(si) && !"football".equals(si)) continue;
                    if ("all".equals(sport) || si.equals(sport)) kept.add(it);
                }
            }
            data.put("items", kept);
            long at = cachedAt("lives");
            data.put("updatedAt", at > 0 ? at : System.currentTimeMillis());
            return json(200, data);
        } catch (Exception e) {
            return json(502, map("error", "直播列表加载失败", "detail", msg(e)));
        }
    }

    private Response apiLive(Map<String, String> qs) {
        final String target = qs.containsKey("u") ? qs.get("u") : "";
        URL parsed;
        try {
            parsed = new URL(target);
        } catch (Exception e) {
            return json(400, map("error", "u 不合法"));
        }
        String protocol = parsed.getProtocol();
        if (!("http".equals(protocol) || "https".equals(protocol))
                || !parsed.getPath().matches("^/play/steam\\d+\\.html$")) {
            return json(403, map("error", "地址未授权"));
        }
        try {
            Object value = cached("live:" + target, new Loader() {
                @Override
                public Object load() throws Exception {
                    String html = fetchText(target, JRKAN + "/");
                    Map<String, Object> m = new LinkedHashMap<String, Object>();
                    m.put("lines", parseLiveSources(html, target));
                    return m;
                }
            }, 2 * 60 * 1000L, false);
            Map<String, Object> data = new LinkedHashMap<String, Object>();
            if (value instanceof Map) data.putAll((Map<String, Object>) value);
            data.put("source", target);
            return json(200, data);
        } catch (Exception e) {
            return json(502, map("error", "直播线路解析失败", "detail", msg(e)));
        }
    }

    private Response apiRank(Map<String, String> qs) {
        String kind = "player".equals(qs.get("kind")) ? "player" : "team";
        final String k = kind;
        final int type = "player".equals(kind) ? 2 : 0;
        final boolean force = "1".equals(qs.get("refresh"));
        try {
            Object data = cached("rank:" + kind, new Loader() {
                @Override
                public Object load() throws Exception {
                    String body = fetchText(QQ + "/match/api/v2/statistic/rankings?competition_id="
                            + NBA_ID + "&type=" + type + "&scene=pc", null);
                    return parseRank(parseJson(body), k);
                }
            }, 30 * 60 * 1000L, force);
            return json(200, data);
        } catch (Exception e) {
            return json(502, map("error", "排名加载失败", "detail", msg(e)));
        }
    }

    private Response apiSchedule(Map<String, String> qs) {
        final String date = qs.containsKey("date") ? qs.get("date") : "";
        if (!date.matches("^\\d{4}-\\d{2}-\\d{2}$")) {
            return json(400, map("error", "日期不合法"));
        }
        final boolean force = "1".equals(qs.get("refresh"));
        String today = new SimpleDateFormat("yyyy-MM-dd", Locale.CHINA).format(new Date());
        long ttl;
        if (date.compareTo(today) < 0) ttl = TTL_FOREVER;
        else if (date.equals(today)) ttl = 5 * 60 * 1000L;
        else ttl = 60 * 60 * 1000L;
        try {
            Object data = cached("schedule:" + date, new Loader() {
                @Override
                public Object load() throws Exception {
                    String body = fetchText(QQ + "/matchUnion/list?columnId=" + NBA_ID
                            + "&startTime=" + date + "&endTime=" + date
                            + "&timestamp=" + System.currentTimeMillis(), null);
                    return parseSchedule(parseJson(body), date);
                }
            }, ttl, force);
            return json(200, data);
        } catch (Exception e) {
            return json(502, map("error", "赛程加载失败", "detail", msg(e)));
        }
    }

    private Response apiReplay(Map<String, String> qs) {
        final String id = qs.containsKey("id") ? qs.get("id") : "";
        if (!id.matches("^/replay/\\d+-\\d+$")) {
            return json(400, map("error", "id 不合法"));
        }
        try {
            Object value = cached("detail:" + id, new Loader() {
                @Override
                public Object load() throws Exception {
                    String html = fetchText(SITE + id + "?source=dooqiuluxiang", null);
                    return parseDetail(html);
                }
            }, 5 * 60 * 1000L, false);
            Map<String, Object> data = new LinkedHashMap<String, Object>();
            data.put("id", id);
            data.put("url", SITE + id + "?source=dooqiuluxiang");
            if (value instanceof Map) data.putAll((Map<String, Object>) value);
            return json(200, data);
        } catch (Exception e) {
            return json(502, map("error", "抓取失败", "detail", msg(e)));
        }
    }

    private Response apiHls(Map<String, String> qs) {
        String target = qs.containsKey("u") ? qs.get("u") : "";
        URL parsed;
        try {
            parsed = new URL(target);
        } catch (Exception e) {
            return json(400, map("error", "u 不合法"));
        }
        if (!"https".equals(parsed.getProtocol()) || !isAllowed(target, parsed)) {
            return json(403, map("error", "地址未授权"));
        }
        try {
            HttpResult upstream = request(parsed.toString(), 0, "");
            boolean isPlaylist = upstream.contentType.toLowerCase(Locale.ROOT).contains("mpegurl")
                    || parsed.getPath().toLowerCase(Locale.ROOT).endsWith(".m3u8");
            if (isPlaylist) {
                String body = rewritePlaylist(upstream.text(), parsed.toString());
                return new Response(200, "application/vnd.apple.mpegurl",
                        body.getBytes(StandardCharsets.UTF_8), "no-store");
            }
            String type = upstream.contentType.isEmpty() ? "video/mp2t" : upstream.contentType;
            return new Response(200, type, upstream.bytes, "public, max-age=3600");
        } catch (Exception e) {
            return json(502, map("error", "转发失败", "detail", msg(e)));
        }
    }

    // ---------------- 缓存 ----------------

    private Object cached(String key, Loader loader, long ttl, boolean force) throws Exception {
        CacheEntry entry;
        synchronized (CACHE_LOCK) {
            entry = CACHE.get(key);
        }
        if (entry != null && !force) {
            boolean fresh;
            if (ttl == TTL_FOREVER) {
                fresh = true;
            } else if (ttl == TTL_REPLAY) {
                fresh = replayListFresh(entry.at);
            } else if (ttl == TTL_DAY) {
                fresh = localDay(entry.at).equals(localDay(System.currentTimeMillis()));
            } else {
                fresh = System.currentTimeMillis() - entry.at < ttl;
            }
            if (fresh) return entry.value;
        }
        Object value = loader.load();
        synchronized (CACHE_LOCK) {
            CACHE.put(key, new CacheEntry(System.currentTimeMillis(), value));
        }
        return value;
    }

    private long cachedAt(String key) {
        synchronized (CACHE_LOCK) {
            CacheEntry e = CACHE.get(key);
            return e == null ? 0 : e.at;
        }
    }

    private static String localDay(long ts) {
        Calendar c = Calendar.getInstance();
        c.setTimeInMillis(ts);
        return c.get(Calendar.YEAR) + "-" + (c.get(Calendar.MONTH) + 1) + "-" + c.get(Calendar.DAY_OF_MONTH);
    }

    /** 15 点后当天只抓一次；0-15 点 10 分钟内复用 */
    private static boolean replayListFresh(long at) {
        Calendar now = Calendar.getInstance();
        if (now.get(Calendar.HOUR_OF_DAY) >= 15) {
            Calendar a = Calendar.getInstance();
            a.setTimeInMillis(at);
            return localDay(at).equals(localDay(System.currentTimeMillis()))
                    && a.get(Calendar.HOUR_OF_DAY) >= 15;
        }
        return System.currentTimeMillis() - at < 10 * 60 * 1000L;
    }

    // ---------------- 抓取 ----------------

    private static class HttpResult {
        byte[] bytes;
        String contentType = "";

        String text() {
            return new String(bytes, StandardCharsets.UTF_8);
        }
    }

    private static HttpResult request(String target, int depth, String referer) throws IOException {
        HttpURLConnection conn = (HttpURLConnection) new URL(target).openConnection();
        conn.setConnectTimeout(15000);
        conn.setReadTimeout(25000);
        conn.setInstanceFollowRedirects(false);
        conn.setRequestProperty("User-Agent", UA);
        conn.setRequestProperty("Accept", "*/*");
        conn.setRequestProperty("Accept-Language", "zh-CN,zh;q=0.9");
        if (referer != null && !referer.isEmpty()) conn.setRequestProperty("Referer", referer);

        int code = conn.getResponseCode();
        if (code >= 300 && code < 400 && depth < 4) {
            String location = conn.getHeaderField("Location");
            conn.disconnect();
            if (location == null) throw new IOException("HTTP " + code);
            return request(new URL(new URL(target), location).toString(), depth + 1, referer);
        }
        if (code != 200) {
            conn.disconnect();
            throw new IOException("HTTP " + code);
        }

        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        InputStream is = conn.getInputStream();
        byte[] chunk = new byte[8192];
        int n;
        while ((n = is.read(chunk)) > 0) buffer.write(chunk, 0, n);
        is.close();

        HttpResult result = new HttpResult();
        result.bytes = buffer.toByteArray();
        String type = conn.getContentType();
        result.contentType = type == null ? "" : type;
        conn.disconnect();
        return result;
    }

    private static String fetchText(String target, String referer) throws IOException {
        return request(target, 0, referer).text();
    }

    // ---------------- B 站视频 / 封面代理 --------------

    private static final String BILI_API = "https://api.bilibili.com";
    private static final String BILI_REFER = "https://www.bilibili.com/";
    private static final long BILI_VIEW_TTL = 6 * 60 * 60 * 1000L;
    private static final long BILI_PLAY_TTL = 20 * 60 * 1000L;
    private static final long BILI_COVER_TTL = 6 * 60 * 60 * 1000L;

    private static boolean validBv(String bv) {
        return bv != null && Pattern.matches("^BV[0-9A-Za-z]{10}$", bv);
    }

    /** 稿件信息（标题 / 封面 / cid / 时长），缓存 6 小时 */
    @SuppressWarnings("unchecked")
    private Map<String, Object> biliView(String bv) throws Exception {
        Object value = cached("bili:view:" + bv, new Loader() {
            @Override
            public Object load() throws Exception {
                String body = fetchText(BILI_API + "/x/web-interface/view?bvid=" + bv, BILI_REFER);
                Object root = parseJson(body);
                if (!(root instanceof Map)) throw new IOException("返回格式异常");
                Object code = ((Map<String, Object>) root).get("code");
                if (!"0".equals(str(code))) throw new IOException("B站返回 " + str(code));
                Object data = ((Map<String, Object>) root).get("data");
                if (!(data instanceof Map)) throw new IOException("稿件不存在");
                return data;
            }
        }, BILI_VIEW_TTL, false);
        return (Map<String, Object>) value;
    }

    /** 取一条可直连的 mp4 地址，缓存 20 分钟；B站链接约 2 小时过期 */
    @SuppressWarnings("unchecked")
    private Map<String, Object> biliPlay(final String bv) throws Exception {
        Object value = cached("bili:play:" + bv, new Loader() {
            @Override
            public Object load() throws Exception {
                Map<String, Object> view = biliView(bv);
                String cid = num(view.get("cid"));
                String body = fetchText(BILI_API + "/x/player/playurl?bvid=" + bv + "&cid=" + cid
                        + "&qn=64&fnval=0&platform=html5&high_quality=1", BILI_REFER);
                Object root = parseJson(body);
                if (!(root instanceof Map)) throw new IOException("返回格式异常");
                if (!"0".equals(str(((Map<String, Object>) root).get("code")))) {
                    throw new IOException("B站取流失败 " + str(((Map<String, Object>) root).get("code")));
                }
                Object data = ((Map<String, Object>) root).get("data");
                if (!(data instanceof Map)) throw new IOException("无播放数据");
                Object durl = ((Map<String, Object>) data).get("durl");
                if (!(durl instanceof List) || ((List<?>) durl).isEmpty()) throw new IOException("无播放地址");
                Object first = ((List<?>) durl).get(0);
                if (!(first instanceof Map)) throw new IOException("无播放地址");
                String url = str(((Map<String, Object>) first).get("url"));
                if (url.isEmpty()) throw new IOException("无播放地址");
                Map<String, Object> out = new LinkedHashMap<String, Object>();
                out.put("url", url);
                return out;
            }
        }, BILI_PLAY_TTL, false);
        return (Map<String, Object>) value;
    }

    private Response apiBiliView(Map<String, String> qs) {
        String bv = qs.get("bv");
        if (!validBv(bv)) return json(400, map("error", "bv 参数不合法"));
        try {
            Map<String, Object> view = biliView(bv);
            Map<String, Object> data = new LinkedHashMap<String, Object>();
            data.put("bv", bv);
            data.put("title", str(view.get("title")));
            data.put("cid", num(view.get("cid")));
            data.put("duration", num(view.get("duration")));
            return json(200, data);
        } catch (Exception e) {
            return json(502, map("error", "稿件信息获取失败", "detail", msg(e)));
        }
    }

    private Response apiBiliCover(Map<String, String> qs) {
        final String bv = qs.get("bv");
        if (!validBv(bv)) return json(400, map("error", "bv 参数不合法"));
        try {
            Object value = cached("bili:cover:" + bv, new Loader() {
                @Override
                public Object load() throws Exception {
                    Map<String, Object> view = biliView(bv);
                    String pic = str(view.get("pic"));
                    if (pic.isEmpty()) throw new IOException("没有封面");
                    // B站封面多为 http，本站走 https 时会被浏览器拦，统一改写
                    if (pic.startsWith("http://")) pic = "https://" + pic.substring(7);
                    return request(pic, 0, BILI_REFER);
                }
            }, BILI_COVER_TTL, false);
            if (!(value instanceof HttpResult)) return json(502, map("error", "封面获取失败"));
            HttpResult pic = (HttpResult) value;
            String type = pic.contentType;
            if (type == null || type.isEmpty() || !type.startsWith("image/")) type = "image/jpeg";
            return new Response(200, type, pic.bytes, "public, max-age=21600");
        } catch (Exception e) {
            return json(502, map("error", "封面获取失败", "detail", msg(e)));
        }
    }

    /** 把 B 站 mp4 边读边转发给 WebView，Range 原样透传，支持拖动进度条 */
    private void streamBiliVideo(OutputStream out, String bv, String range) {
        if (!validBv(bv)) {
            try {
                write(out, json(400, map("error", "bv 参数不合法")));
            } catch (IOException ignored) {
            }
            return;
        }
        HttpURLConnection conn = null;
        InputStream is = null;
        try {
            Map<String, Object> play = biliPlay(bv);
            String target = str(play.get("url"));
            if (target.isEmpty()) {
                write(out, json(502, map("error", "取流失败")));
                return;
            }

            conn = (HttpURLConnection) new URL(target).openConnection();
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(30000);
            conn.setInstanceFollowRedirects(true);
            conn.setRequestProperty("User-Agent", UA);
            conn.setRequestProperty("Referer", BILI_REFER);
            conn.setRequestProperty("Accept", "*/*");
            if (range != null && range.startsWith("bytes=")) conn.setRequestProperty("Range", range);

            int code = conn.getResponseCode();
            if (code != 200 && code != 206) {
                write(out, json(502, map("error", "上游返回 " + code)));
                return;
            }

            long length = conn.getContentLengthLong();
            String contentRange = conn.getHeaderField("Content-Range");

            StringBuilder head = new StringBuilder();
            head.append("HTTP/1.1 ").append(code).append(' ').append(statusText(code)).append("\r\n");
            head.append("Content-Type: video/mp4\r\n");
            if (length > 0) head.append("Content-Length: ").append(length).append("\r\n");
            head.append("Accept-Ranges: bytes\r\n");
            if (contentRange != null && !contentRange.isEmpty()) {
                head.append("Content-Range: ").append(contentRange).append("\r\n");
            }
            head.append("Access-Control-Allow-Origin: *\r\n");
            head.append("Cache-Control: no-store\r\n");
            head.append("Connection: close\r\n\r\n");
            out.write(head.toString().getBytes(StandardCharsets.UTF_8));

            is = conn.getInputStream();
            byte[] buffer = new byte[16384];
            int n;
            while ((n = is.read(buffer)) > 0) out.write(buffer, 0, n);
            out.flush();
        } catch (Exception ignored) {
            // 客户端中途退出或上游超时，关掉连接即可
        } finally {
            if (is != null) {
                try {
                    is.close();
                } catch (IOException ignored) {
                }
            }
            if (conn != null) conn.disconnect();
        }
    }

    // ---------------- 解析：回放列表 / 详情 ----------------

    private static String stripTags(String html) {
        return html.replaceAll("<[^>]+>", "")
                .replace("&nbsp;", " ")
                .replace("&amp;", "&")
                .replace("&lt;", "<")
                .replace("&gt;", ">")
                .replace("&quot;", "\"")
                .replaceAll("\\s+", " ")
                .trim();
    }

    private static Map<String, Object> parseTitle(String title) {
        Matcher dateM = Pattern.compile("^(\\d{4})年(\\d{1,2})月(\\d{1,2})日\\s*").matcher(title);
        String rest = title;
        String date = "";
        if (dateM.find()) {
            rest = title.substring(dateM.end());
            date = dateM.group(1) + "-" + pad2(dateM.group(2)) + "-" + pad2(dateM.group(3));
        }
        rest = rest.replaceAll("(赛事回放|录像回放|全场录像|回放|集锦).*$", "").trim();

        Matcher vsM = Pattern.compile("^(.*?)\\s*(?:vs|VS|Vs)\\s*(.*)$").matcher(rest);
        String home = rest;
        String away = "";
        if (vsM.find()) {
            home = vsM.group(1).trim();
            away = vsM.group(2).trim();
        }
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("date", date);
        out.put("home", home);
        out.put("away", away);
        return out;
    }

    private static String pad2(String v) {
        return v.length() >= 2 ? v : "0" + v;
    }

    private static Map<String, Object> parseList(String html) {
        List<Object> items = new ArrayList<Object>();
        String[] chunks = html.split("<a href=\"/replay/", -1);
        for (int i = 1; i < chunks.length; i++) {
            String chunk = chunks[i];
            int end = chunk.indexOf("</a>");
            String cut = end >= 0 ? chunk.substring(0, end) : chunk;

            Matcher idM = Pattern.compile("^(\\d+-\\d+)\"").matcher(chunk);
            if (!idM.find()) continue;
            Matcher titleM = Pattern.compile("(?s)<h2>(.*?)</h2>").matcher(cut);
            if (!titleM.find()) continue;

            String id = idM.group(1);
            String title = stripTags(titleM.group(1));
            Matcher coverM = Pattern.compile("<img[^>]+src=\"([^\"]+)\"").matcher(cut);
            Matcher timeM = Pattern.compile("(?s)<time>(.*?)</time>").matcher(cut);
            Matcher leagueM = Pattern.compile("<span>([^<]*)</span>\\s*<time>").matcher(cut);

            Map<String, Object> it = new LinkedHashMap<String, Object>();
            it.put("id", "/replay/" + id);
            it.put("url", SITE + "/replay/" + id + "?source=dooqiuluxiang");
            it.put("title", title);
            it.put("cover", coverM.find() ? coverM.group(1) : "");
            it.put("time", timeM.find() ? stripTags(timeM.group(1)) : "");
            it.put("league", leagueM.find() ? stripTags(leagueM.group(1)) : "");
            it.putAll(parseTitle(title));
            items.add(it);
        }

        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("items", items);
        Matcher pager = Pattern.compile("<span>\\s*(\\d+)\\s*/\\s*(\\d+)\\s*</span>").matcher(html);
        int page = 1;
        int totalPages = 1;
        if (pager.find()) {
            try {
                page = Integer.parseInt(pager.group(1));
                totalPages = Integer.parseInt(pager.group(2));
            } catch (Exception ignored) {
            }
        }
        out.put("page", Double.valueOf(page));
        out.put("totalPages", Double.valueOf(totalPages));
        return out;
    }

    private static Map<String, Object> parseDetail(String html) {
        String decoded = html.replace("\\u002F", "/");

        Matcher tm = Pattern.compile("(?s)<title>(.*?)</title>").matcher(html);
        String title = stripTags(tm.find() ? tm.group(1) : "");
        title = title.replaceAll("\\s*-\\s*豆包直播.*$", "");

        Matcher coverM = Pattern.compile("https://[^\"]*replay-thumbnails/[^\"]*\\.(?:jpg|png|webp)").matcher(decoded);
        String cover = coverM.find() ? coverM.group(0) : "";

        List<Object> lines = new ArrayList<Object>();
        List<String> seen = new ArrayList<String>();
        Matcher urlM = Pattern.compile("https://[^\"\\s]+?\\.m3u8").matcher(decoded);
        while (urlM.find()) {
            String url = urlM.group(0);
            if (seen.contains(url)) continue;
            seen.add(url);

            String before = decoded.substring(Math.max(0, urlM.start() - 400), urlM.start());
            Matcher labels = Pattern.compile("\"([^\"]{1,20}回放)\"").matcher(before);
            String full = "回放";
            while (labels.find()) full = labels.group(1);

            String label = full.replaceAll("回放$", "");
            if (label.isEmpty()) label = "回放";

            Map<String, Object> line = new LinkedHashMap<String, Object>();
            line.put("label", label);
            line.put("full", full);
            line.put("url", url);
            lines.add(line);
        }

        int preferred = -1;
        for (int i = 0; i < lines.size(); i++) {
            Object full = ((Map<?, ?>) lines.get(i)).get("full");
            if (full != null && String.valueOf(full).contains("中文高清")) {
                preferred = i;
                break;
            }
        }

        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("title", title);
        out.put("cover", cover);
        out.put("lines", lines);
        out.put("defaultIndex", preferred >= 0 ? preferred : 0);
        return out;
    }

    // ---------------- 腾讯体育：排名 / 赛程 ----------------

    private static final String[] RANK_COLS = {"rank", "team", "wins", "losses", "winRate", "streak"};
    private static final String[] PLAYER_COLS = {"rank", "player", "team", "games", "rankValue"};

    private static Object parseRank(Object json, String kind) throws Exception {
        if (!(json instanceof Map)) throw new Exception("排名接口返回异常");
        Map<?, ?> root = (Map<?, ?>) json;
        if (!num(root.get("code")).equals("0") || !(root.get("data") instanceof Map)) {
            throw new Exception("排名接口返回异常");
        }
        Map<?, ?> data = (Map<?, ?>) root.get("data");
        List<Object> tabs = new ArrayList<Object>();
        Object groupsRaw = data.get("groups");
        if (groupsRaw instanceof List) {
            for (Object g : (List<?>) groupsRaw) {
                if (!(g instanceof Map)) continue;
                Map<?, ?> group = (Map<?, ?>) g;
                List<Object> tables = new ArrayList<Object>();
                Object tablesRaw = group.get("tables");
                if (tablesRaw instanceof List) {
                    for (Object t : (List<?>) tablesRaw) {
                        if (!(t instanceof Map)) continue;
                        tables.add(parseRankTable((Map<?, ?>) t, kind));
                    }
                }
                Map<String, Object> tab = new LinkedHashMap<String, Object>();
                tab.put("code", str(group.get("code")));
                tab.put("name", str(group.get("name")));
                tab.put("tables", tables);
                tabs.add(tab);
            }
        }
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("kind", kind);
        out.put("tabs", tabs);
        return out;
    }

    private static Map<String, Object> parseRankTable(Map<?, ?> table, String kind) {
        String[] cols = "player".equals(kind) ? PLAYER_COLS : RANK_COLS;
        List<Object> headers = new ArrayList<Object>();
        String title = "";
        Object headersRaw = table.get("headers");
        if (headersRaw instanceof List) {
            for (Object h : (List<?>) headersRaw) {
                if (!(h instanceof Map)) continue;
                Map<?, ?> header = (Map<?, ?>) h;
                String code = str(header.get("code"));
                for (String col : cols) {
                    if (col.equals(code)) headers.add(str(header.get("name")));
                }
                if (num(header.get("idx")).equals("1") && title.isEmpty()) title = str(header.get("name"));
            }
        }

        List<Object> rows = new ArrayList<Object>();
        Object rowsRaw = table.get("rows");
        if (rowsRaw instanceof List) {
            int limit = "player".equals(kind) ? 20 : 40;
            int count = 0;
            for (Object r : (List<?>) rowsRaw) {
                if (count >= limit) break;
                if (!(r instanceof Map)) continue;
                Object valuesRaw = ((Map<?, ?>) r).get("values");
                if (!(valuesRaw instanceof List)) continue;
                List<?> values = (List<?>) valuesRaw;
                Object team = pick(values, "team");
                Object player = pick(values, "player");
                Map<String, Object> row = new LinkedHashMap<String, Object>();
                row.put("rank", str(pick(values, "rank")));
                row.put("name", "player".equals(kind) ? valName(player) : valName(team));
                row.put("team", "player".equals(kind) ? valName(team) : "");
                row.put("logo", logoOf(team));
                row.put("wins", str(pick(values, "wins")));
                row.put("losses", str(pick(values, "losses")));
                row.put("winRate", str(pick(values, "winRate")));
                row.put("streak", str(pick(values, "streak")));
                row.put("games", str(pick(values, "games")));
                row.put("value", str(pick(values, "rankValue")));
                rows.add(row);
                count++;
            }
        }

        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("title", title);
        out.put("headers", headers);
        out.put("rows", rows);
        return out;
    }

    private static Object pick(List<?> values, String code) {
        for (Object v : values) {
            if (v instanceof Map && code.equals(str(((Map<?, ?>) v).get("code")))) {
                return ((Map<?, ?>) v).get("value");
            }
        }
        return null;
    }

    private static String valName(Object v) {
        if (v == null) return "";
        if (v instanceof String) return (String) v;
        if (v instanceof Map) {
            Map<?, ?> m = (Map<?, ?>) v;
            String cn = str(m.get("cnName"));
            return cn.isEmpty() ? str(m.get("enName")) : cn;
        }
        return "";
    }

    private static String logoOf(Object team) {
        if (team instanceof Map) return str(((Map<?, ?>) team).get("logo"));
        return "";
    }

    private static Object parseSchedule(Object json, String date) throws Exception {
        if (!(json instanceof Map)) throw new Exception("赛程接口返回异常");
        Map<?, ?> root = (Map<?, ?>) json;
        if (!num(root.get("code")).equals("0") || !(root.get("data") instanceof Map)) {
            throw new Exception("赛程接口返回异常");
        }
        Map<?, ?> data = (Map<?, ?>) root.get("data");
        Object listRaw = data.get(date);
        List<Object> items = new ArrayList<Object>();
        if (listRaw instanceof List) {
            for (Object o : (List<?>) listRaw) {
                if (!(o instanceof Map)) continue;
                Map<?, ?> m = (Map<?, ?>) o;
                String leftBadge = str(m.get("leftBadge"));
                String rightBadge = str(m.get("rightBadge"));
                String leftName = str(m.get("leftName"));
                String rightName = str(m.get("rightName"));
                if (leftBadge.isEmpty() || rightBadge.isEmpty() || leftName.isEmpty() || rightName.isEmpty()) continue;
                if (!NBA_ID.equals(num(m.get("competitionId")))) continue;

                String startTime = str(m.get("startTime"));
                Map<String, Object> item = new LinkedHashMap<String, Object>();
                item.put("mid", m.get("mid"));
                item.put("time", startTime.length() >= 16 ? startTime.substring(11, 16) : "");
                item.put("startTime", startTime);
                item.put("home", teamInfo(leftName, leftBadge, str(m.get("leftGoal"))));
                item.put("away", teamInfo(rightName, rightBadge, str(m.get("rightGoal"))));
                item.put("desc", str(m.get("matchDesc")));
                item.put("live", str(m.get("livePeriod")).isEmpty() ? "0" : str(m.get("livePeriod")));
                items.add(item);
            }
        }
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("date", date);
        out.put("items", items);
        return out;
    }

    private static Map<String, Object> teamInfo(String name, String logo, String score) {
        Map<String, Object> m = new LinkedHashMap<String, Object>();
        m.put("name", name);
        m.put("logo", logo);
        m.put("score", score);
        return m;
    }

    // ---------------- JRKAN 直播 ----------------

    private static Map<String, String> parseHosts(String html) {
        Map<String, String> hosts = new HashMap<String, String>();
        Matcher m = Pattern.compile("(line\\d+):\\s*atob\\(\"([^\"]+)\"\\)").matcher(html);
        while (m.find()) {
            try {
                hosts.put(m.group(1), base64Decode(m.group(2)).replaceAll("/+$", ""));
            } catch (Exception ignored) {
            }
        }
        return hosts;
    }

    private static String base64Decode(String in) {
        String chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        int val = 0;
        int bits = 0;
        for (int i = 0; i < in.length(); i++) {
            char c = in.charAt(i);
            if (c == '=') break;
            int idx = chars.indexOf(c);
            if (idx < 0) continue;
            val = (val << 6) | idx;
            bits += 6;
            if (bits >= 8) {
                bits -= 8;
                out.write((val >> bits) & 0xFF);
            }
        }
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }

    private static String innerText(String block, String regex) {
        Matcher m = Pattern.compile(regex).matcher(block);
        return m.find() ? stripTags(m.group(1)) : "";
    }

    private static String absoluteLogo(String src) {
        if (src == null || src.isEmpty()) return "";
        if (src.startsWith("//")) return "https:" + src;
        if (src.startsWith("/")) return JRKAN + src;
        return src;
    }

    private static Map<String, Object> parseLives(String js, Map<String, String> hosts) {
        List<Object> items = new ArrayList<Object>();
        String[] blocks = js.split("<ul class=\"item play", -1);
        for (int i = 1; i < blocks.length; i++) {
            String raw = blocks[i];
            Matcher lidM = Pattern.compile("data-lid=\"([^\"]+)\"").matcher(raw);
            String lid = lidM.find() ? lidM.group(1) : "";
            String[] lidParts = lid.split(",");
            if (lidParts.length < 2) continue;
            String sportType = lidParts[1];
            // 项目 1 足球 / 2 篮球
            if (!"1".equals(sportType) && !"2".equals(sportType)) continue;
            String sport = "1".equals(sportType) ? "football" : "basketball";

            String league = innerText(raw, "<li class=\"lab_events\"[^>]*><span class=\"name\">([^<]*)</span>");
            String time = innerText(raw, "<li class=\"lab_time\">([^<]*)</li>");
            String homeName = innerText(raw, "(?s)<li class=\"lab_team_home\">.*?<strong class=\"name\">([^<]*)</strong>");
            String awayName = innerText(raw, "(?s)<li class=\"lab_team_away\">.*?<strong class=\"name\">([^<]*)</strong>");

            Matcher homeLogoM = Pattern.compile("(?s)<li class=\"lab_team_home\">.*?<img[^>]+src=\"([^\"]+)\"").matcher(raw);
            Matcher awayLogoM = Pattern.compile("(?s)<li class=\"lab_team_away\">.*?<img[^>]+src=\"([^\"]+)\"").matcher(raw);
            String homeLogo = absoluteLogo(homeLogoM.find() ? homeLogoM.group(1) : "");
            String awayLogo = absoluteLogo(awayLogoM.find() ? awayLogoM.group(1) : "");

            Matcher vsM = Pattern.compile("(?s)<li class=\"lab_vs[^\"]*\">(.*?)</li>").matcher(raw);
            String status = vsM.find() ? stripTags(vsM.group(1)) : "";

            String url = "";
            Matcher channelM = Pattern.compile("(?s)<li class=\"lab_channel\">(.*?)</li>").matcher(raw);
            if (channelM.find()) {
                List<String> anchors = new ArrayList<String>();
                Matcher a = Pattern.compile("<a[^>]*>").matcher(channelM.group(1));
                while (a.find()) anchors.add(a.group(0));
                if (anchors.size() > 1) {
                    Matcher pm = Pattern.compile("getPlayUrl\\(\"(line\\d+)\",\\s*\"(\\d+)\"\\)").matcher(anchors.get(1));
                    if (pm.find() && hosts.containsKey(pm.group(1))) {
                        url = hosts.get(pm.group(1)) + "/play/steam" + pm.group(2) + ".html";
                    }
                }
            }

            if (league.isEmpty() || url.isEmpty()) continue;

            Map<String, Object> item = new LinkedHashMap<String, Object>();
            item.put("id", lid);
            item.put("sport", sport);
            item.put("league", league);
            item.put("time", time);
            item.put("status", status);
            item.put("home", liveTeam(homeName, homeLogo));
            item.put("away", liveTeam(awayName, awayLogo));
            item.put("url", url);
            items.add(item);
        }
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("items", items);
        return out;
    }

    private static Map<String, Object> liveTeam(String name, String logo) {
        Map<String, Object> m = new LinkedHashMap<String, Object>();
        m.put("name", name);
        m.put("logo", logo);
        return m;
    }

    private static Map<String, Object> fetchLives() throws IOException {
        String referer = JRKAN + "/";
        String home = fetchText(referer, referer);
        Map<String, String> hosts = parseHosts(home);

        Matcher srcM = Pattern.compile("<script[^>]+src=\"([^\"]*index\\.js[^\"]*)\"").matcher(home);
        String src;
        if (srcM.find()) {
            String raw = srcM.group(1);
            if (raw.startsWith("//")) raw = "https:" + raw;
            src = new URL(new URL(referer), raw).toString();
        } else {
            src = "https://im-imgs-bucket.oss-accelerate.aliyuncs.com/index.js?t_5";
        }

        String js = fetchText(src, referer);
        return parseLives(js, hosts);
    }

    private static List<Object> parseLiveSources(String html, String base) {
        List<Object> lines = new ArrayList<Object>();
        List<String> seen = new ArrayList<String>();

        Matcher m = Pattern.compile("(?s)<a\\b[^>]*data-play=\"([^\"]*)\"[^>]*>(.*?)</a>").matcher(html);
        while (m.find()) {
            addLine(lines, seen, stripTags(m.group(2)).trim(), m.group(1).trim(), base);
        }

        Matcher frame = Pattern.compile("<iframe[^>]*class=\"[^\"]*sub_player[^\"]*\"[^>]*src=\"([^\"]+)\"").matcher(html);
        if (frame.find()) addLine(lines, seen, "默认线路", frame.group(1), base);

        final List<Object> sorted = lines;
        Collections.sort(sorted, new java.util.Comparator<Object>() {
            @Override
            public int compare(Object a, Object b) {
                return scoreLine(a) - scoreLine(b);
            }
        });
        return sorted;
    }

    private static int scoreLine(Object line) {
        String label = str(((Map<?, ?>) line).get("label"));
        String url = str(((Map<?, ?>) line).get("url"));
        if (label.contains("高清")) return 0;
        if (url.matches(".*/play/sm\\.html$")) return 2;
        return 1;
    }

    private static void addLine(List<Object> lines, List<String> seen, String label, String play, String base) {
        if (play == null || !play.startsWith("/play/")) return;
        String abs;
        try {
            abs = new URL(new URL(base), play.replace("&amp;", "&")).toString();
        } catch (Exception e) {
            return;
        }
        if (seen.contains(abs)) return;
        seen.add(abs);
        Map<String, Object> line = new LinkedHashMap<String, Object>();
        line.put("label", label.isEmpty() ? "线路 " + (lines.size() + 1) : label);
        line.put("url", abs);
        lines.add(line);
    }

    // ---------------- m3u8 代理 ----------------

    private static String proxyUrl(String abs) {
        ALLOWED.put(abs, System.currentTimeMillis() + ALLOW_TTL);
        try {
            return "/api/hls?u=" + URLEncoder.encode(abs, "UTF-8");
        } catch (Exception e) {
            return abs;
        }
    }

    private static boolean isAllowed(String target, URL parsed) {
        String host = parsed.getHost() == null ? "" : parsed.getHost();
        if (host.equals("rtmpcdn.com") || host.endsWith(".rtmpcdn.com")) return true;
        Long exp = ALLOWED.get(target);
        return exp != null && exp > System.currentTimeMillis();
    }

    private static String rewritePlaylist(String text, String base) {
        String[] lines = text.split("\\r?\\n", -1);
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < lines.length; i++) {
            if (i > 0) out.append('\n');
            String line = lines[i];
            String t = line.trim();
            if (t.isEmpty()) {
                out.append(line);
                continue;
            }
            if (t.startsWith("#")) {
                Matcher uriM = Pattern.compile("URI=\"([^\"]+)\"").matcher(line);
                if (uriM.find()) {
                    try {
                        String proxied = proxyUrl(new URL(new URL(base), uriM.group(1)).toString());
                        out.append(line.substring(0, uriM.start()))
                                .append("URI=\"").append(proxied).append('"')
                                .append(line.substring(uriM.end()));
                    } catch (Exception e) {
                        out.append(line);
                    }
                } else {
                    out.append(line);
                }
            } else {
                try {
                    out.append(proxyUrl(new URL(new URL(base), t).toString()));
                } catch (Exception e) {
                    out.append(line);
                }
            }
        }
        return out.toString();
    }

    // ---------------- 极简 JSON ----------------

    private static String msg(Exception e) {
        return e.getMessage() == null ? e.toString() : e.getMessage();
    }

    private static Response json(int status, Object data) {
        return new Response(status, "application/json; charset=utf-8",
                toJson(data).getBytes(StandardCharsets.UTF_8), "no-store");
    }

    private static Response rawJson(String body) {
        return new Response(200, "application/json; charset=utf-8",
                body.getBytes(StandardCharsets.UTF_8), "public, max-age=600");
    }

    private static Map<String, Object> map(Object... kv) {
        Map<String, Object> m = new LinkedHashMap<String, Object>();
        for (int i = 0; i + 1 < kv.length; i += 2) m.put(String.valueOf(kv[i]), kv[i + 1]);
        return m;
    }

    private static String str(Object v) {
        if (v == null) return "";
        if (v instanceof Double) return num(v);
        return String.valueOf(v);
    }

    private static String num(Object v) {
        if (v == null) return "";
        if (v instanceof Number) {
            double d = ((Number) v).doubleValue();
            if (d == Math.rint(d)) return String.valueOf((long) d);
            return String.valueOf(d);
        }
        return String.valueOf(v);
    }

    private static Object parseJson(String s) {
        return new JsonParser(s).parse();
    }

    private static String toJson(Object o) {
        StringBuilder sb = new StringBuilder();
        writeJson(o, sb);
        return sb.toString();
    }

    private static void writeJson(Object o, StringBuilder sb) {
        if (o == null) {
            sb.append("null");
        } else if (o instanceof String) {
            quote((String) o, sb);
        } else if (o instanceof Boolean) {
            sb.append(o.toString());
        } else if (o instanceof Number) {
            double d = ((Number) o).doubleValue();
            if (d == Math.rint(d) && !Double.isInfinite(d)) sb.append((long) d);
            else sb.append(d);
        } else if (o instanceof Map) {
            sb.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> e : ((Map<?, ?>) o).entrySet()) {
                if (!first) sb.append(',');
                first = false;
                quote(String.valueOf(e.getKey()), sb);
                sb.append(':');
                writeJson(e.getValue(), sb);
            }
            sb.append('}');
        } else if (o instanceof List) {
            sb.append('[');
            boolean first = true;
            for (Object v : (List<?>) o) {
                if (!first) sb.append(',');
                first = false;
                writeJson(v, sb);
            }
            sb.append(']');
        } else {
            quote(String.valueOf(o), sb);
        }
    }

    private static void quote(String s, StringBuilder sb) {
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        sb.append('"');
    }

    private static class JsonParser {
        private final String s;
        private int i;

        JsonParser(String s) {
            this.s = s;
        }

        Object parse() {
            skip();
            return value();
        }

        private void skip() {
            while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++;
        }

        private Object value() {
            skip();
            if (i >= s.length()) return null;
            char c = s.charAt(i);
            if (c == '{') return object();
            if (c == '[') return array();
            if (c == '"') return string();
            if (s.startsWith("true", i)) {
                i += 4;
                return Boolean.TRUE;
            }
            if (s.startsWith("false", i)) {
                i += 5;
                return Boolean.FALSE;
            }
            if (s.startsWith("null", i)) {
                i += 4;
                return null;
            }
            return number();
        }

        private Map<String, Object> object() {
            Map<String, Object> m = new LinkedHashMap<String, Object>();
            i++;
            skip();
            if (i < s.length() && s.charAt(i) == '}') {
                i++;
                return m;
            }
            while (i < s.length()) {
                skip();
                if (i >= s.length() || s.charAt(i) != '"') break;
                String key = string();
                skip();
                if (i < s.length() && s.charAt(i) == ':') i++;
                m.put(key, value());
                skip();
                if (i < s.length() && s.charAt(i) == ',') {
                    i++;
                    continue;
                }
                if (i < s.length() && s.charAt(i) == '}') i++;
                break;
            }
            return m;
        }

        private List<Object> array() {
            List<Object> list = new ArrayList<Object>();
            i++;
            skip();
            if (i < s.length() && s.charAt(i) == ']') {
                i++;
                return list;
            }
            while (i < s.length()) {
                list.add(value());
                skip();
                if (i < s.length() && s.charAt(i) == ',') {
                    i++;
                    continue;
                }
                if (i < s.length() && s.charAt(i) == ']') i++;
                break;
            }
            return list;
        }

        private String string() {
            StringBuilder sb = new StringBuilder();
            if (i < s.length() && s.charAt(i) == '"') i++;
            while (i < s.length()) {
                char c = s.charAt(i++);
                if (c == '"') break;
                if (c == '\\' && i < s.length()) {
                    char e = s.charAt(i++);
                    switch (e) {
                        case 'n': sb.append('\n'); break;
                        case 't': sb.append('\t'); break;
                        case 'r': sb.append('\r'); break;
                        case 'b': sb.append('\b'); break;
                        case 'f': sb.append('\f'); break;
                        case '/': sb.append('/'); break;
                        case '\\': sb.append('\\'); break;
                        case '"': sb.append('"'); break;
                        case 'u':
                            if (i + 4 <= s.length()) {
                                try {
                                    sb.append((char) Integer.parseInt(s.substring(i, i + 4), 16));
                                } catch (Exception ignored) {
                                }
                                i += 4;
                            }
                            break;
                        default: sb.append(e);
                    }
                } else {
                    sb.append(c);
                }
            }
            return sb.toString();
        }

        private Object number() {
            int start = i;
            while (i < s.length()) {
                char c = s.charAt(i);
                if ((c >= '0' && c <= '9') || c == '-' || c == '+' || c == '.' || c == 'e' || c == 'E') i++;
                else break;
            }
            try {
                return Double.valueOf(s.substring(start, i));
            } catch (Exception e) {
                return null;
            }
        }
    }

    /** 本机调试用：java com.wuxie.sports.TvServer [port] */
    public static void main(String[] args) {
        int port = DEFAULT_PORT;
        if (args.length > 0) port = Integer.parseInt(args[0]);
        new TvServer(port).start();
        System.out.println("wuxie tv server on http://127.0.0.1:" + port);
        try {
            Thread.sleep(Long.MAX_VALUE);
        } catch (InterruptedException ignored) {
        }
    }
}
