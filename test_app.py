"""OMETSUKE プロトタイプのスモークテストです。

ヘッドレス Chromium + 疑似カメラで 2 つのシナリオを確認します。

1. MediaPipe モジュールをフェイクに差し替え、キャリブレーション → セッション →
   報酬計算 → 履歴保存までの一連のロジックが動くこと。
2. 実際の CDN から MediaPipe を読み込み、顔が映らない場合に
   「顔が見つかりませんでした」のエラーで安全に戻ること。
"""

import pathlib
import subprocess
import sys
import time

from playwright.sync_api import sync_playwright

APP_DIR = str(pathlib.Path(__file__).resolve().parent)
PORT = 8123
BASE_URL = f"http://localhost:{PORT}/index.html"

# 顔が正面を向いている状態を表す単位行列 (列優先 4x4) です。
IDENTITY_16 = "[1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]"

# 常に正面向きの顔を 1 つ返すフェイクの MediaPipe モジュールです。
FAKE_MEDIAPIPE = f"""
export class FilesetResolver {{
  static async forVisionTasks() {{ return {{}}; }}
}}
export class FaceLandmarker {{
  static async createFromOptions() {{ return new FaceLandmarker(); }}
  detectForVideo() {{
    return {{
      facialTransformationMatrixes: [{{ data: new Float32Array({IDENTITY_16}) }}],
    }};
  }}
}}
"""


def launch_browser(p):
    """疑似カメラつきのヘッドレス Chromium を起動します。

    Args:
        p: sync_playwright のコンテキスト。

    Returns:
        起動済みの Browser。
    """
    return p.chromium.launch(
        args=[
            "--use-fake-ui-for-media-stream",
            "--use-fake-device-for-media-stream",
        ]
    )


def collect_errors(page):
    """ページのコンソール エラーと pageerror を収集するリスナーを登録します。

    Args:
        page: 対象の Page。

    Returns:
        エラー文字列が追記されていくリスト。
    """
    errors = []
    page.on(
        "console",
        lambda msg: errors.append(f"console.{msg.type}: {msg.text}")
        if msg.type == "error"
        else None,
    )
    page.on("pageerror", lambda err: errors.append(f"pageerror: {err}"))
    return errors


def test_full_session_with_fake_mediapipe(browser):
    """フェイク MediaPipe で 3 秒セッションを完走し、報酬と履歴を検証します。

    Args:
        browser: 起動済みの Browser。

    Returns:
        None。失敗時は AssertionError を送出します。
    """
    page = browser.new_page()
    errors = collect_errors(page)

    # CDN の MediaPipe をフェイク モジュールに差し替えます。
    page.route(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision*",
        lambda route: route.fulfill(
            body=FAKE_MEDIAPIPE, content_type="application/javascript"
        ),
    )

    page.goto(BASE_URL)
    assert page.title() == "OMETSUKE — お目付け役", f"タイトル不一致: {page.title()}"
    assert page.locator("#screen-home").is_visible(), "ホーム画面が表示されていません"
    assert page.locator("#total-koban").inner_text() == "0", "初期の小判が 0 ではありません"

    # 15 分の選択肢の値を 0.05 分 (3 秒) に書き換えて短時間で完走させます。
    page.evaluate(
        """() => {
            const radio = document.querySelector('input[name="duration"][value="15"]');
            radio.value = "0.05";
            radio.checked = true;
        }"""
    )
    page.click("#btn-start")

    # キャリブレーション (3 秒) + セッション (3 秒) を経て結果画面に到達します。
    page.wait_for_selector("#screen-result:not([hidden])", timeout=20000)
    koban = page.locator("#result-koban").inner_text()
    ratio = page.locator("#result-ratio").inner_text()
    assert koban == "+5", f"報酬が +5 ではありません: {koban}"
    assert ratio == "100%", f"集中率が 100% ではありません: {ratio}"

    # ホームに戻ると累計と履歴が更新されています。
    page.click("#btn-home")
    page.wait_for_selector("#screen-home:not([hidden])")
    assert page.locator("#total-koban").inner_text() == "5", "累計小判が 5 ではありません"
    history_text = page.locator("#history-list li").first.inner_text()
    assert "🪙+5" in history_text, f"履歴に報酬がありません: {history_text}"

    assert not errors, f"コンソール エラーがあります: {errors}"
    page.close()
    print("OK: フェイク MediaPipe でのセッション完走テスト")


def test_real_cdn_no_face(browser):
    """実際の CDN ライブラリで、顔なし映像がエラーで安全に戻ることを検証します。

    Args:
        browser: 起動済みの Browser。

    Returns:
        None。失敗時は AssertionError を送出します。
    """
    page = browser.new_page()
    page.goto(BASE_URL)
    page.click("#btn-start")

    # 疑似カメラの映像に顔は映らないため、キャリブレーション失敗で
    # ホームに戻りエラーメッセージが出るはずです (モデル取得込みで待ちます)。
    page.wait_for_selector("#home-error:not([hidden])", timeout=60000)
    message = page.locator("#home-error").inner_text()
    assert "顔が見つかりませんでした" in message, f"想定外のエラー文言: {message}"
    assert not page.locator("#btn-start").is_disabled(), "開始ボタンが無効のままです"
    page.close()
    print("OK: 実 CDN + 顔なし映像のフォールバック テスト")


def main():
    """ローカル サーバーを立ててテストを順に実行します。

    Returns:
        None。失敗時は例外で異常終了します。
    """
    server = subprocess.Popen(
        [sys.executable, "-m", "http.server", str(PORT)],
        cwd=APP_DIR,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    time.sleep(1)
    try:
        with sync_playwright() as p:
            browser = launch_browser(p)
            test_full_session_with_fake_mediapipe(browser)
            test_real_cdn_no_face(browser)
            browser.close()
    finally:
        server.terminate()
    print("すべてのテストに合格しました")


if __name__ == "__main__":
    main()
