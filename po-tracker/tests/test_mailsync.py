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
             "lines": [{"pn": "P-1", "qty": 2, "unit_price": 150, "next_step": "STEP-1", "note": "不要"}],
             "mails": [mail(20, "2026-11-14T09:00:00+09:00", "PO 44400 Due 12/1") | {"body": "不要"}]}
        out, n = mailsync.merge(BASE, [m])
        self.assertEqual(n, 1)
        o = self.by(out)["44400|华晨"]
        self.assertEqual(o["status"], "已下单")  # 邮件里说已确认也不管，人来定
        self.assertEqual((o["source"], o["mail_new"], o["due_date"], o["due_text"], o["amount"]),
                         ("mail", True, "2026-12-01", "12/1", 300))
        for k in ("status_note", "open_issues", "doubts", "tracking", "note", "updated_at"):
            self.assertNotIn(k, o)
        self.assertEqual(o["lines"], [{"pn": "P-1", "qty": 2, "unit_price": 150, "next_step": "STEP-1"}])
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

    def test_alias_match_needs_same_customer_po_or_part(self):
        base = [{"po": "90137", "supplier": "华晨", "status": "已完成", "customer_po": "C-OLD-1",
                 "lines": [{"pn": "P-OLD"}], "source": "tracker"},
                {"po": "44278A", "supplier": "兴华", "customer_po": "C-X-01 / TBD", "lines": [{"pn": "X-1"}]}]
        # 标题把 90317 写成了 90137：号对上老单，但客户 PO、零件都不一样 → 新单，老单不挂这些信
        typo = {"po": "90317", "aliases": ["90137"], "supplier": "华晨", "customer_po": "C-NEW-1",
                "lines": [{"pn": "P-NEW"}], "mails": [mail(60, "2026-11-13", "PO 90137")]}
        # 加字母的：零件对得上就算同一张
        suffix = {"po": "44278", "supplier": "兴华", "customer_po": "TBD", "lines": [{"pn": "x-1"}], "mails": [mail(61, "2026-11-13")]}
        out, n = mailsync.merge(base, [typo, suffix])
        by = self.by(out)
        self.assertEqual(n, 1)
        self.assertEqual((by["90317|华晨"]["status"], by["90317|华晨"]["mail_new"]), ("已下单", True))
        self.assertNotIn("mails", by["90137|华晨"])
        self.assertEqual(by["44278A|兴华"]["mails"][0]["uid"], 61)
        # 同号只是供应商没定的，不看客户 PO
        out, n = mailsync.merge(base, [{"po": "90137", "supplier": "", "customer_po": "C-OTHER-9", "mails": [mail(62, "2026-11-14")]}])
        self.assertEqual((n, self.by(out)["90137|华晨"]["mails"][0]["uid"]), (0, 62))

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

    def test_sub_vendor_only_filled_when_missing(self):
        base = [{"po": "1", "supplier": "凯阔"}, {"po": "2", "supplier": "凯阔", "sub_vendor": "人填的"}]
        out, n = mailsync.merge(base, [{"po": "1", "supplier": "凯阔", "sub_vendor": "ABC"},
                                       {"po": "2", "supplier": "凯阔", "sub_vendor": "ABC"},
                                       {"po": "3", "supplier": "凯阔", "sub_vendor": "ABC"}])
        self.assertEqual([o.get("sub_vendor") for o in out], ["ABC", "人填的", "ABC"])
        self.assertEqual(n, 1)

    def test_next_step_only_filled_when_missing(self):
        base = [{"po": "1", "supplier": "凯维", "source": "mail",
                 "lines": [{"pn": "P-1", "qty": 1}, {"pn": "P-2", "next_step": "人填的"}, {"pn": "P-3"}]}]
        out, n = mailsync.merge(base, [{"po": "1", "supplier": "凯维",
                                        "lines": [{"pn": "p-1", "next_step": "STEP-1"}, {"pn": "P-2", "next_step": "STEP-2"}]}])
        self.assertEqual(n, 0)
        self.assertEqual([ln.get("next_step") for ln in out[0]["lines"]], ["STEP-1", "人填的", None])
        self.assertEqual(out[0]["lines"][0]["qty"], 1)
        self.assertNotIn("next_step", base[0]["lines"][0])  # 传进来的不改

    def test_junk_skipped(self):
        out, n = mailsync.merge(BASE, [None, {}, {"po": " "}, "x"])
        self.assertEqual((len(out), n), (3, 0))


if __name__ == "__main__":
    unittest.main()
