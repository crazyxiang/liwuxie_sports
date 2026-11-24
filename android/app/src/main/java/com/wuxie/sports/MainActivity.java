package com.wuxie.sports;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

/**
 * 原生壳：全屏 WebView 加载 app/web 里的页面。
 * 打包时会自动把 app/web 作为 assets 打进去，路径是 file:///android_asset/index.html
 */
public class MainActivity extends Activity {

    /**
     * 电视端自带数据服务（TvServer，监听 127.0.0.1:8099），
     * 抓取 / 解析 / m3u8 转发都在电视本机完成，不再依赖电脑。
     */
    private static final String API_BASE = "http://127.0.0.1:8099";

    private static final int API_PORT = 8099;

    private TvServer tvServer;
    private FrameLayout root;
    private WebView webView;
    private WebChromeClient chromeClient;
    private View customView;
    private WebChromeClient.CustomViewCallback customViewCallback;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        setContentView(R.layout.activity_main);

        // 电视本机起一个数据服务，页面只跟 127.0.0.1 打交道
        tvServer = new TvServer(API_PORT, this);
        tvServer.start();

        root = findViewById(R.id.root);
        webView = findViewById(R.id.webview);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(true);
        // 有 viewport meta 时不要再按“缩放到整页”渲染，否则手机上会整页缩小、出现横向滚动
        settings.setLoadWithOverviewMode(false);
        settings.setUseWideViewPort(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(true);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }

        webView.setBackgroundColor(Color.parseColor("#06070A"));
        webView.addJavascriptInterface(new NativeBridge(), "NativeApp");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return openExternal(url);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return openExternal(request.getUrl().toString());
            }
        });

        chromeClient = new WebChromeClient() {
            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (customView != null) {
                    callback.onCustomViewHidden();
                    return;
                }
                customView = view;
                customViewCallback = callback;
                root.addView(view, new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT));
                webView.setVisibility(View.GONE);
            }

            @Override
            public void onHideCustomView() {
                if (customView == null) return;
                root.removeView(customView);
                customView = null;
                webView.setVisibility(View.VISIBLE);
                if (customViewCallback != null) {
                    customViewCallback.onCustomViewHidden();
                    customViewCallback = null;
                }
            }
        };
        webView.setWebChromeClient(chromeClient);

        String url = "file:///android_asset/index.html";
        if (!API_BASE.isEmpty()) {
            url += "?api=" + Uri.encode(API_BASE);
        }
        webView.loadUrl(url);
        // 让 WebView 自己持有焦点，遥控器方向键 / OK 才会进入页面
        webView.setFocusable(true);
        webView.requestFocus();
    }

    @Override
    protected void onDestroy() {
        if (tvServer != null) tvServer.stop();
        super.onDestroy();
    }

    /** 站内页面留在 WebView，外部链接（直播地址）交给系统浏览器 */
    private boolean openExternal(String url) {
        if (url == null || url.startsWith("file://") || url.startsWith("javascript:")) return false;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (Exception ignored) {
            /* 没有可用的浏览器时忽略 */
        }
        return true;
    }

    public class NativeBridge {
        @JavascriptInterface
        public void openUrl(final String url) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    openExternal(url);
                }
            });
        }
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            if (customView != null) {
                chromeClient.onHideCustomView();
                return true;
            }
            // 交给页面处理：视频放大时先缩小，否则回上一页
            webView.evaluateJavascript(
                    "window.TV && window.TV.onBack ? (window.TV.onBack(), 'handled') : 'fallback'",
                    new ValueCallback<String>() {
                        @Override
                        public void onReceiveValue(String value) {
                            if (value != null && value.contains("fallback") && webView.canGoBack()) {
                                webView.goBack();
                            }
                        }
                    });
            return true;
        }
        if (isTvKey(keyCode)) {
            sendKey("onKey", keyCode, event.getRepeatCount());
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    public boolean onKeyUp(int keyCode, KeyEvent event) {
        if (isTvKey(keyCode)) {
            sendKey("onKeyUp", keyCode, 0);
            return true;
        }
        return super.onKeyUp(keyCode, event);
    }

    /** 遥控器 / 手柄上需要交给页面处理的按键 */
    private boolean isTvKey(int code) {
        switch (code) {
            case KeyEvent.KEYCODE_DPAD_UP:
            case KeyEvent.KEYCODE_DPAD_DOWN:
            case KeyEvent.KEYCODE_DPAD_LEFT:
            case KeyEvent.KEYCODE_DPAD_RIGHT:
            case KeyEvent.KEYCODE_DPAD_CENTER:
            case KeyEvent.KEYCODE_ENTER:
            case KeyEvent.KEYCODE_NUMPAD_ENTER:
            case KeyEvent.KEYCODE_BUTTON_A:
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
            case KeyEvent.KEYCODE_MEDIA_PLAY:
            case KeyEvent.KEYCODE_MEDIA_PAUSE:
            case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD:
            case KeyEvent.KEYCODE_MEDIA_REWIND:
            case KeyEvent.KEYCODE_MEDIA_NEXT:
            case KeyEvent.KEYCODE_MEDIA_PREVIOUS:
                return true;
            default:
                return false;
        }
    }

    /** 把原始按键码转发给页面，由 window.TV.onKey / onKeyUp 统一处理 */
    private void sendKey(String fn, int code, int repeat) {
        String js = "window.TV && window.TV." + fn + " && window.TV." + fn + "(" + code;
        if ("onKey".equals(fn)) js += "," + repeat;
        js += ")";
        webView.evaluateJavascript(js, null);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (!hasFocus) return;
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    }
}
