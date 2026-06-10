import unittest

from vinted_pulse.analysis import analyze_description


class DescriptionHeuristics(unittest.TestCase):
    def test_rich_english_description(self):
        d = analyze_description(
            "Stunning classic Ralph Lauren oxford shirt in light blue. "
            "Excellent condition, no stains. Pit to pit 52 cm, length 74 cm. "
            "Size M. #ralphlauren #preppy"
        )
        self.assertTrue(d["has_measurements"])
        self.assertTrue(d["mentions_size"])
        self.assertTrue(d["mentions_condition"])
        self.assertIn("stunning", d["flavour_words"])
        self.assertIn("classic", d["flavour_words"])
        self.assertTrue(d["has_hashtags"])
        self.assertEqual(d["length_class"], "medium")

    def test_swedish_description(self):
        d = analyze_description("Snygg skjorta i nyskick. Bröst: 54 cm. Stl L.")
        self.assertTrue(d["has_measurements"])
        self.assertTrue(d["mentions_size"])
        self.assertTrue(d["mentions_condition"])
        self.assertIn("snygg", d["flavour_words"])
        self.assertEqual(d["length_class"], "short")

    def test_bare_description(self):
        d = analyze_description("Blue shirt.")
        self.assertFalse(d["has_measurements"])
        self.assertFalse(d["mentions_condition"])
        self.assertEqual(d["flavour_word_count"], 0)
        self.assertEqual(d["length_class"], "short")

    def test_empty(self):
        d = analyze_description(None)
        self.assertEqual(d["length_class"], "empty")
        self.assertEqual(d["word_count"], 0)

    def test_long_class(self):
        d = analyze_description("word " * 100)
        self.assertEqual(d["length_class"], "long")


if __name__ == "__main__":
    unittest.main()
