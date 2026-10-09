"""Browser end-to-end test + screenshots.

Needs: the app on $APP_URL (default http://127.0.0.1:8099), and the fake SMTP catcher
(`node test/fake-smtp.mjs 2526 <maildir>`) writing messages into $MAIL_DIR.
Usage: python3 test/ui_test.py <screenshot-dir>
"""
import glob
import json
import os
import sys
import time

from playwright.sync_api import expect, sync_playwright

APP = os.environ.get("APP_URL", "http://127.0.0.1:8099")
MAIL_DIR = os.environ.get("MAIL_DIR", "/tmp/mm-mail")
SMTP_PORT = os.environ.get("SMTP_PORT", "2526")
SHOTS = sys.argv[1] if len(sys.argv) > 1 else "shots"
CHROME = os.environ.get("CHROME", "/usr/bin/google-chrome")
os.makedirs(SHOTS, exist_ok=True)


def mails():
    out = []
    for f in sorted(glob.glob(os.path.join(MAIL_DIR, "*.json")), key=lambda p: int(os.path.basename(p)[:-5])):
        with open(f) as fh:
            out.append(json.load(fh))
    return out


def no_hscroll(page, label):
    sw, iw = page.evaluate("[document.documentElement.scrollWidth, window.innerWidth]")
    assert sw <= iw, f"{label}: horizontal scroll ({sw} > {iw})"


def tab(page, name):
    page.click(f".tabs button[data-tab={name}]")


def shoot_all(page, width):
    for name in ["sender", "template", "recipients", "send", "sync"]:
        tab(page, name)
        page.wait_for_timeout(400)
        no_hscroll(page, f"{name}@{width}")
        page.screenshot(path=os.path.join(SHOTS, f"{width}-{name}.png"), full_page=True)


with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=CHROME, args=["--no-sandbox"])
    ctx = browser.new_context(viewport={"width": 1400, "height": 900}, accept_downloads=True)
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("dialog", lambda d: (errors.append("native dialog: " + d.message), d.dismiss()))
    page.goto(APP)

    # --- Sender: display name is required ---
    tab(page, "sender")
    page.fill("[name=host]", "127.0.0.1")
    page.select_option("[name=security]", "none")
    page.fill("[name=port]", SMTP_PORT)
    page.fill("[name=user]", "tester")
    page.fill("[name=pass]", "secret")
    page.fill("[name=fromAddress]", "deyao@example.com")
    page.click("#verifyBtn")
    expect(page.locator("#verifyStatus")).to_contain_text("display name is required")
    expect(page.locator("[data-err=fromName]")).to_be_visible()
    page.fill("[name=fromName]", "Deyao Chen")
    expect(page.locator("#fromPreview")).to_have_text("Deyao Chen <deyao@example.com>")
    page.click("#verifyBtn")
    expect(page.locator("#verifyStatus")).to_have_text("Connected and logged in.")

    # --- Template ---
    tab(page, "template")
    page.click("#subject")
    page.type("#subject", "Hello ")
    page.click(".chip[data-ph=name]")
    page.type("#subject", ", a note for you")
    expect(page.locator("#subject")).to_have_value("Hello {{name}}, a note for you")
    page.click(".jodit-wysiwyg")
    page.keyboard.type("Dear ")
    page.click(".chip[data-ph=name]")
    page.keyboard.type(",")
    page.keyboard.press("Enter")
    page.keyboard.press("Control+b")
    page.keyboard.type("Bold line")
    page.keyboard.press("Control+b")
    page.keyboard.type(" sent to ")
    page.click(".chip[data-ph=email]")
    page.keyboard.press("Enter")
    page.click(".jodit-toolbar-button_ul .jodit-toolbar-button__button")
    page.keyboard.type("first point")
    page.keyboard.press("Enter")
    page.keyboard.type("second point")
    html = page.evaluate("JSON.parse(localStorage.getItem('mailmerge.template')).html")
    assert "{{name}}" in html and "<strong>Bold line</strong>" in html and "<ul>" in html, html

    # --- Recipients: download template, import it, edit list ---
    tab(page, "recipients")
    with page.expect_download() as dl:
        page.click("#templateDl")
    tpl_path = os.path.join(SHOTS, "..", "mailmerge-template-downloaded.xlsx")
    dl.value.save_as(tpl_path)
    assert dl.value.suggested_filename == "mailmerge-recipients-template.xlsx"
    page.set_input_files("#importFile", tpl_path)
    expect(page.locator("#importSummary")).to_contain_text("Found 1 row")
    expect(page.locator("#importSummary")).to_contain_text("header row skipped")
    page.click("#importReplace")
    expect(page.locator("#list .row")).to_have_count(1)
    assert page.input_value("#list .row .r-name") == "Jane Doe"
    assert page.input_value("#list .row .r-email") == "jane@example.com"

    def add(name, email):
        page.click("#addRow")
        row = page.locator("#list .row").last
        row.locator(".r-name").fill(name)
        row.locator(".r-email").fill(email)

    add("Zhang Wei 张伟", "zhang@example.com")
    add("O'Brien <Pat>", "pat@example.com")
    add("Bounce", "bounce@example.com")
    add("Dup", "JANE@example.com")
    expect(page.locator("#listBanner")).to_contain_text("more than once")
    add("Typo", "typo@example")
    expect(page.locator("#listBanner")).to_contain_text("invalid email")
    page.screenshot(path=os.path.join(SHOTS, "1400-recipients-warnings.png"), full_page=True)
    page.click("#listBanner >> text=Remove duplicates")
    expect(page.locator("#list .row")).to_have_count(5)
    # deselect the Bounce row
    page.locator("#list .row").nth(3).locator(".r-chk").uncheck()
    assert page.locator("#list .row").nth(3).locator(".r-email").input_value() == "bounce@example.com"

    # Preview for a recipient with HTML-ish name
    tab(page, "template")
    page.select_option("#previewFor", label="O'Brien <Pat> — pat@example.com")
    expect(page.locator("#pvSubject")).to_have_text("Hello O'Brien <Pat>, a note for you")
    body = page.frame_locator("#previewFrame").locator("body")
    expect(body).to_contain_text("Dear O'Brien <Pat>,")
    expect(body).to_contain_text("sent to pat@example.com")

    shoot_all(page, 1400)

    # --- Send ---
    tab(page, "send")
    page.fill("#delay", "0.2")
    expect(page.locator("#checklist")).to_contain_text("3 recipients will get an email")
    expect(page.locator("#checklist")).to_contain_text("invalid email will be skipped")
    before = len(mails())
    page.click("#sendBtn")
    expect(page.locator("#dialog")).to_be_visible()
    page.screenshot(path=os.path.join(SHOTS, "1400-send-dialog.png"))
    page.click("#dialogActions >> text=Send now")
    expect(page.locator("#sendSummary")).to_contain_text("Finished. 3 sent, 0 failed", timeout=15000)
    sent = mails()[before:]
    assert len(sent) == 3, len(sent)
    by_to = {m["envelopeTo"][0]: m for m in sent}
    assert set(by_to) == {"jane@example.com", "zhang@example.com", "pat@example.com"}, by_to.keys()
    for m in sent:
        assert m["from"][0]["name"] == "Deyao Chen" and m["from"][0]["address"] == "deyao@example.com", m["from"]
        assert m["fromHeaderRaw"] == 'From: Deyao Chen <deyao@example.com>' or "Deyao Chen" in m["fromHeaderRaw"], m["fromHeaderRaw"]
        assert m["html"] and m["text"], "missing part"
        assert "{{" not in m["html"] and "{{" not in m["subject"] and "{{" not in m["text"]
    pat = by_to["pat@example.com"]
    assert pat["subject"] == "Hello O'Brien <Pat>, a note for you", pat["subject"]
    assert "O&#39;Brien &lt;Pat&gt;" in pat["html"] or "O'Brien &lt;Pat&gt;" in pat["html"], pat["html"]
    assert "<Pat>" not in pat["html"]
    assert "Dear O'Brien <Pat>," in pat["text"], pat["text"]
    assert "<strong>Bold line</strong>" in pat["html"]
    zh = by_to["zhang@example.com"]
    assert zh["subject"].startswith("Hello Zhang Wei 张伟"), zh["subject"]
    tab(page, "recipients")
    expect(page.locator("#list .badge.sent")).to_have_count(3)
    page.screenshot(path=os.path.join(SHOTS, "1400-recipients-after-send.png"), full_page=True)

    # --- Send test ---
    tab(page, "send")
    page.fill("#testTo", "me@example.com")
    page.click("#testBtn")
    expect(page.locator("#testStatus")).to_have_text("Sent to me@example.com.")
    assert mails()[-1]["envelopeTo"] == ["me@example.com"]
    page.screenshot(path=os.path.join(SHOTS, "1400-send-done.png"), full_page=True)

    # --- Sync: export, wipe, import ---
    tab(page, "sync")
    page.click("#exportBtn")
    expect(page.locator("#exportOut")).to_contain_text("anyone who has it can log in to the mailbox and send email as you")
    key = page.input_value("#exportText")
    page.screenshot(path=os.path.join(SHOTS, "1400-sync-export.png"), full_page=True)
    page.evaluate("localStorage.clear()")
    page.reload()
    tab(page, "sync")
    page.fill("#importText", key)
    page.click("#importBtn")
    page.click("#dialogActions >> text=Replace")
    expect(page.locator(".toast")).to_contain_text("Settings imported")
    tab(page, "sender")
    assert page.input_value("[name=fromName]") == "Deyao Chen"
    assert page.input_value("[name=pass]") == "secret"
    tab(page, "recipients")
    expect(page.locator("#list .row")).to_have_count(5)
    tab(page, "template")
    expect(page.locator(".jodit-wysiwyg strong")).to_have_text("Bold line")

    # --- Phone width ---
    mob = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
    mpage = mob.new_page()
    mpage.on("pageerror", lambda e: errors.append(str(e)))
    mpage.goto(APP)
    mpage.click(".tabs button[data-tab=sync]")
    mpage.fill("#importText", key)
    mpage.click("#importBtn")
    mpage.click("#dialogActions >> text=Replace")
    shoot_all(mpage, 390)
    mpage.click(".tabs button[data-tab=sync]")
    mpage.click("#exportBtn")
    mpage.screenshot(path=os.path.join(SHOTS, "390-sync-export.png"), full_page=True)

    assert not errors, errors
    browser.close()
    print("UI test passed")
