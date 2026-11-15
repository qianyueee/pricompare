"""mailsync.py（每小时邮件抓的 PO 合进页面）的测试：只挂邮件、只加新单、不加任何备注和判断。"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import mailsync  # noqa: E402


def mail(uid, date, subject="PO", folder="收件箱"):
    return {"folder": folder, "uid": uid, "date": date, "from": "Gene", "subject": subject}


BASE = [
    {"po": "44278", "supplier": "凯维", "status": "已确认", "due_date": "2026-11-20", "note": "在做", "source": "tracker",
     "mails": [mail(10, "2026-11-01T10:00:00+09:00")], "last_mail_at": "2026-11-01T10:00:00+09:00"},
    {"po": "44278A", "supplier": "兴华", "status": "已下单", "due_date": "2026-11-22", "source": "tracker"},
    {"po": "44300", "supplier": "", "status": "未定", "source": "mail"},
]


class MergeTest(unittest.TestCase):
    def by(self, orders):
        return {f"{o['po']}|{o.get('supplier') or ''}": o for o in orders}

    def test_new_po_gets_raw_fields_only(self):
        m = {"po": "44400", "supplier": "华晨", "due_date": "2026-12-01", "due_text": "12/1", "amount": 300,
             "status": "已确认", "status_note": "华晨回 confirmed", "open_issues": ["没回"], "doubts": ["?"],
             "tracking": "123", "note": "x", "updated_at": "…",
             "lines": [{"pn": "P-1", "qty": 2, "unit_price": 150, "note": "不要"}],
             "mails": [mail(20, "2026-11-14T09:00:00+09:00", "PO 44400 Due 12/1") | {"body": "不要"}]}
        out, n = mailsync.merge(BASE, [m])
        self.assertEqual(n, 1)
        o = self.by(out)["44400|华晨"]
        self.assertEqual(o["status"], "已下单")  # 邮件里说已确认也不管，人来定
        self.assertEqual((o["source"], o["mail_new"], o["due_date"], o["due_text"], o["amount"]),
                         ("mail", True, "2026-12-01", "12/1", 300))
        for k in ("status_note", "open_issues", "doubts", "tracking", "note", "updated_at"):
            self.assertNotIn(k, o)
        self.assertEqual(o["lines"], [{"pn": "P-1", "qty": 2, "unit_price": 150}])
        self.assertEqual(o["mails"], [mail(20, "2026-11-14T09:00:00+09:00", "PO 44400 Due 12/1")])

    def test_existing_po_only_gets_new_mails(self):
        m = {"po": "44278", "supplier": "凯维", "status": "已发货", "due_date": "2026-12-30", "status_note": "发了",
             "mails": [mail(10, "2026-11-01T10:00:00+09:00"), mail(30, "2026-11-14T08:00:00+09:00", "Re: PO 44278")]}
        out, n = mailsync.merge(BASE, [m])
        self.assertEqual(n, 0)
        o = self.by(out)["44278|凯维"]
        self.assertEqual((o["status"], o["due_date"], o["note"]), ("已确认", "2026-11-20", "在做"))
        self.assertNotIn("status_note", o)
        self.assertEqual([x["uid"] for x in o["mails"]], [30, 10])  # 新的在前，旧的不重复
        self.assertEqual(o["last_mail_at"], "2026-11-14T08:00:00+09:00")
        self.assertEqual(len(BASE[0]["mails"]), 1)  # 传进来的不改

    def test_letter_suffix_and_aliases(self):
        out, n = mailsync.merge(BASE, [{"po": "44278", "supplier": "兴华", "mails": [mail(40, "2026-11-14")]},
                                       {"po": "44500", "aliases": ["44278A"], "supplier": "兴华", "mails": [mail(41, "2026-11-15")]}])
        self.assertEqual(n, 0)
        self.assertEqual([x["uid"] for x in self.by(out)["44278A|兴华"]["mails"]], [41, 40])

    def test_supplier_unknown_on_one_side(self):
        out, n = mailsync.merge(BASE, [{"po": "44300", "supplier": "凯维", "mails": [mail(50, "2026-11-14")]},
                                       {"po": "44278A", "supplier": "", "mails": [mail(51, "2026-11-14")]}])
        self.assertEqual(n, 0)
        by = self.by(out)
        self.assertEqual(by["44300|"]["mails"][0]["uid"], 50)
        self.assertEqual(by["44278A|兴华"]["mails"][0]["uid"], 51)

    def test_same_number_other_supplier_is_new(self):
        out, n = mailsync.merge(BASE, [{"po": "44278", "supplier": "华晨"}])
        self.assertEqual(n, 1)
        self.assertEqual(self.by(out)["44278|华晨"]["status"], "已下单")

    def test_same_mail_without_uid_not_doubled(self):
        base = [{"po": "1", "supplier": "华晨", "mails": [{"date": "2026-11-01", "subject": "PO 1"}]}]
        out, _ = mailsync.merge(base, [{"po": "1", "supplier": "华晨", "mails": [mail(9, "2026-11-01", "PO 1")]}])
        self.assertEqual(len(out[0]["mails"]), 1)

    def test_junk_skipped(self):
        out, n = mailsync.merge(BASE, [None, {}, {"po": " "}, "x"])
        self.assertEqual((len(out), n), (3, 0))


if __name__ == "__main__":
    unittest.main()
