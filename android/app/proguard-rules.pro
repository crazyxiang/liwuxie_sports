# WebView 里通过 JS 接口调用，不需要额外混淆规则
-keepclassmembers class com.wuxie.sports.MainActivity$NativeBridge {
    public *;
}
