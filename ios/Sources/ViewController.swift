import UIKit
import WebKit

class ViewController: UIViewController, WKNavigationDelegate, WKUIDelegate {

    private var webView: WKWebView!
    private let serverKey = "serverURL"

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        if let saved = UserDefaults.standard.string(forKey: serverKey), !saved.isEmpty {
            setupWebView()
            loadChat(saved)
        }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        if UserDefaults.standard.string(forKey: serverKey)?.isEmpty != false {
            promptServer()
        }
    }

    override var preferredStatusBarStyle: UIStatusBarStyle { .darkContent }

    // MARK: - Setup

    private func setupWebView() {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.defaultWebpagePreferences.allowsContentJavaScript = true

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)

        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
    }

    private func loadChat(_ server: String) {
        var base = server.trimmingCharacters(in: .whitespaces)
        if !base.hasPrefix("http") { base = "https://\(base)" }
        if !base.hasSuffix("/") { base += "/" }
        guard let url = URL(string: "\(base)chat/") else { return }
        var req = URLRequest(url: url)
        req.cachePolicy = .reloadIgnoringLocalCacheData
        webView.load(req)
    }

    // MARK: - Server prompt

    private func promptServer() {
        let alert = UIAlertController(title: "Сервер", message: "Введите адрес сервера", preferredStyle: .alert)
        alert.addTextField { tf in
            tf.placeholder = "chat.company.com"
            tf.keyboardType = .URL
            tf.autocapitalizationType = .none
            tf.autocorrectionType = .no
            tf.text = UserDefaults.standard.string(forKey: self.serverKey) ?? ""
        }
        let connect = UIAlertAction(title: "Подключиться", style: .default) { [weak self, weak alert] _ in
            let text = (alert?.textFields?.first?.text ?? "").trimmingCharacters(in: .whitespaces)
            guard !text.isEmpty, let self else { return }
            UserDefaults.standard.set(text, forKey: self.serverKey)
            self.setupWebView()
            self.loadChat(text)
        }
        alert.addAction(connect)
        alert.preferredAction = connect
        present(alert, animated: true)
    }

    // MARK: - WKNavigationDelegate

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showError(error.localizedDescription)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        showError(error.localizedDescription)
    }

    private func showError(_ message: String) {
        let alert = UIAlertController(title: "Ошибка подключения", message: message, preferredStyle: .alert)
        let retry = UIAlertAction(title: "Повторить", style: .default) { [weak self] _ in
            guard let self, let server = UserDefaults.standard.string(forKey: self.serverKey) else { return }
            self.loadChat(server)
        }
        let change = UIAlertAction(title: "Изменить адрес", style: .default) { [weak self] _ in
            self?.promptServer()
        }
        alert.addAction(retry)
        alert.addAction(change)
        present(alert, animated: true)
    }

    // MARK: - WKUIDelegate (JS dialogs)

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        present(a, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "Отмена", style: .cancel) { _ in completionHandler(false) })
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        present(a, animated: true)
    }
}
