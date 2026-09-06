"""Real CPU model and HTTP checks. Run inside the running container."""
import json
import os
import unittest
import urllib.error
import urllib.request

import numpy as np
from engine import Engine, MODEL_ID, QUERY_PREFIX


class ServiceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.engine = Engine()

    def request(self, texts, input_type="passage", token=None, **extra):
        payload = {"texts": texts, "input_type": input_type, "model": MODEL_ID, **extra}
        req = urllib.request.Request("http://127.0.0.1:8080/embed", data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {token or os.environ['EMBEDDING_SERVICE_TOKEN']}"})
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.load(response)

    def test_semantic_paraphrase_and_normalization(self):
        query = self.request(["Where can the giant rodents warm themselves during cold weather?"], "query")["embeddings"][0]
        result = self.request([
            "Capybaras soak in hot spring baths at Izu Shaboten Zoo in winter.",
            "Software engineers compile programs and investigate database errors.",
            "The mountain is composed of ancient volcanic rock.",
        ])
        vectors = np.array(result["embeddings"])
        self.assertEqual(vectors.shape, (3, 384))
        np.testing.assert_allclose(np.linalg.norm(vectors, axis=1), 1, atol=1e-5)
        self.assertEqual(int(np.argmax(vectors @ query)), 0)

    def test_windows_cover_entire_input_without_truncation(self):
        for text in ["温泉のカピバラ日本" * 250, "hydrochoerus-xqz " * 600]:
            windows, _ = self.engine.windows(text, "passage")
            self.assertEqual("".join(windows), text)
            self.assertGreater(len(windows), 1)
            self.assertTrue(all(len(self.engine.tokenizer.encode(w).ids) <= 512 for w in windows))
        result = self.request(["capybara habitat " * 600])
        self.assertGreater(result["windows"][0], 1)
        self.assertEqual(len(result["embeddings"][0]), 384)

    def test_query_instruction_is_only_for_queries(self):
        self.assertEqual(self.engine.windows("water", "query")[0], [QUERY_PREFIX + "water"])
        self.assertEqual(self.engine.windows("water", "passage")[0], ["water"])

    def test_auth_batch_and_model_validation(self):
        for arguments, status in [
            ({"texts": ["water"], "token": "incorrect"}, 401),
            ({"texts": ["water"] * 17}, 422),
            ({"texts": ["water"], "model": "different-model"}, 422),
            ({"texts": [""]}, 422),
            ({"texts": ["water " * 600], "input_type": "query"}, 422),
        ]:
            with self.subTest(arguments=str(arguments)[:80]):
                with self.assertRaises(urllib.error.HTTPError) as caught:
                    self.request(**arguments)
                self.assertEqual(caught.exception.code, status)


if __name__ == "__main__":
    unittest.main()
