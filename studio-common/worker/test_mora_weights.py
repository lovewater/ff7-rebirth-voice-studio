import unittest
from mora_weights import tokenize, weighted_mora, calibrate


class Weights(unittest.TestCase):
    def test_token_boundaries_and_special_morae(self):
        self.assertEqual(tokenize("キャット、コーヒー にほん"),
                         ["きゃ", "っ", "と", "こ", "ー", "ひ", "ー", "に", "ほ", "ん"])
        self.assertEqual(tokenize("あ、ゃいう"), ["あ", "い", "う"])
        self.assertEqual(weighted_mora("キャット"), 3)
        self.assertAlmostEqual(weighted_mora("キャット", {"きゃ": .9}), 2.9)

    def test_reject_unbounded_or_invalid_weights(self):
        for weights in ({"あ": float("nan")}, {"あ": 0}, {"あい": 1}):
            with self.assertRaises(ValueError):
                weighted_mora("あ", weights)

    def rows(self):
        return [{"stem": str(i), "scene": str(i), "split": split,
                 "segments": [{"kana": k, "duration_s": d}
                              for k, d in [("あ", .1), ("あ", .1), ("あ", .1), ("い", .09), ("う", .11)]]}
                for i, split in enumerate(["train", "test"])]

    def test_fit_and_holdout(self):
        result = calibrate(self.rows(), 1)
        self.assertLess(result["validation"]["weighted"], result["validation"]["baseline"])
        self.assertFalse(result["productionApproved"])
        self.assertLess(result["weights"]["い"], 1)
        self.assertGreater(result["weights"]["う"], 1)
        self.assertEqual(calibrate(self.rows(), 30)["weights"], {})

    def test_no_holdout_leakage(self):
        rows = self.rows()
        old = calibrate(rows, 1)["weights"]
        rows[1]["segments"][3]["duration_s"] = .2
        self.assertEqual(calibrate(rows, 1)["weights"], old)
        rows[1]["scene"] = rows[0]["scene"]
        with self.assertRaises(ValueError):
            calibrate(rows, 1)


if __name__ == "__main__":
    unittest.main()
