package ph.mvltorio.slpknowledgeassistant;

import android.app.Activity;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.http.SslError;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.webkit.SslErrorHandler;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

public class MainActivity extends Activity {
    private static final String PREFS = "slp_webview";
    private static final String KEY_SERVER_URL = "server_url";

    private WebView webView;
    private LinearLayout offlineView;
    private EditText serverUrlInput;
    private SharedPreferences prefs;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        buildLayout();
        configureWebView();
        loadConfiguredUrl();
    }

    private void buildLayout() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.rgb(236, 253, 245));

        webView = new WebView(this);
        root.addView(webView, new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            0,
            1
        ));

        offlineView = new LinearLayout(this);
        offlineView.setOrientation(LinearLayout.VERTICAL);
        offlineView.setGravity(Gravity.CENTER);
        offlineView.setPadding(32, 32, 32, 32);
        offlineView.setBackgroundColor(Color.rgb(236, 253, 245));
        offlineView.setVisibility(View.GONE);

        TextView title = new TextView(this);
        title.setText("SLP Knowledge Assistant is offline");
        title.setTextColor(Color.rgb(6, 78, 59));
        title.setTextSize(20);
        title.setGravity(Gravity.CENTER);
        title.setPadding(0, 0, 0, 16);
        offlineView.addView(title);

        TextView help = new TextView(this);
        help.setText("Make sure the Windows server is running and this phone is on the same Wi-Fi/LAN. Example: http://192.168.50.77:3001");
        help.setTextColor(Color.rgb(51, 65, 85));
        help.setTextSize(14);
        help.setGravity(Gravity.CENTER);
        help.setPadding(0, 0, 0, 20);
        offlineView.addView(help);

        serverUrlInput = new EditText(this);
        serverUrlInput.setSingleLine(true);
        serverUrlInput.setText(currentServerUrl());
        serverUrlInput.setHint("http://PC_IP_ADDRESS:3001");
        offlineView.addView(serverUrlInput, new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        ));

        Button retry = new Button(this);
        retry.setText("Save URL and Retry");
        retry.setOnClickListener(v -> {
            String nextUrl = normalizeUrl(serverUrlInput.getText().toString());
            prefs.edit().putString(KEY_SERVER_URL, nextUrl).apply();
            loadUrl(nextUrl);
        });
        offlineView.addView(retry);

        root.addView(offlineView, new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        ));

        setContentView(root);
    }

    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                offlineView.setVisibility(View.GONE);
                webView.setVisibility(View.VISIBLE);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showOffline();
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.cancel();
                showOffline();
            }
        });
    }

    private void loadConfiguredUrl() {
        loadUrl(currentServerUrl());
    }

    private void loadUrl(String url) {
        serverUrlInput.setText(url);
        offlineView.setVisibility(View.GONE);
        webView.setVisibility(View.VISIBLE);
        webView.loadUrl(url);
    }

    private void showOffline() {
        webView.setVisibility(View.GONE);
        offlineView.setVisibility(View.VISIBLE);
    }

    private String currentServerUrl() {
        return prefs.getString(KEY_SERVER_URL, getString(R.string.default_server_url));
    }

    private String normalizeUrl(String value) {
        String url = value == null ? "" : value.trim();
        if (url.length() == 0) return getString(R.string.default_server_url);
        if (!url.startsWith("http://") && !url.startsWith("https://")) return "http://" + url;
        return url;
    }
}
