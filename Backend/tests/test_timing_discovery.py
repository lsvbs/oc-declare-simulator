"""Timing-discovery window semantics."""

import unittest

from Backend.src.ParameterDiscovery.timediscovery import compute_ocpa_metrics


def log_with_sojourn_values(values):
    objects = {}
    events = {}
    for index, seconds in enumerate(values, start=1):
        object_id = f"o{index}"
        objects[object_id] = {"type": "Order"}
        events[f"a{index}"] = {
            "activity": "Open",
            "timestamp": f"2025-01-01T00:00:00+00:00",
            "omap": [object_id],
        }
        events[f"x{index}"] = {
            "activity": "Close",
            "timestamp": f"2025-01-01T00:00:{seconds:02d}+00:00",
            "omap": [object_id],
        }
    return {"objects": objects, "events": events}


class TimingDiscoveryWindowTests(unittest.TestCase):
    def test_windows_use_the_lower_tail_of_the_selected_samples(self):
        log = log_with_sojourn_values([1, 2, 3, 4])

        minimum = compute_ocpa_metrics(log, service_time_mode="minimum")["Close"]
        p25 = compute_ocpa_metrics(log, service_time_mode="p25")["Close"]
        p50 = compute_ocpa_metrics(log, service_time_mode="p50")["Close"]
        full = compute_ocpa_metrics(log, service_time_mode="mean")["Close"]

        self.assertEqual((1.0, 1.0, 1.0, 4),
                         (minimum["service_mean"], minimum["service_min"],
                          minimum["service_max"], minimum["sample_count"]))
        self.assertEqual((1.0, 1.0, 1.0),
                         (p25["service_mean"], p25["service_min"], p25["service_max"]))
        self.assertEqual((1.5, 1.0, 2.0),
                         (p50["service_mean"], p50["service_min"], p50["service_max"]))
        self.assertEqual((2.5, 1.0, 4.0),
                         (full["service_mean"], full["service_min"], full["service_max"]))

    def test_default_is_p25(self):
        log = log_with_sojourn_values([1, 2, 3, 4])
        default = compute_ocpa_metrics(log)["Close"]
        p25 = compute_ocpa_metrics(log, service_time_mode="p25")["Close"]
        self.assertEqual(p25["service_mean"], default["service_mean"])
        self.assertEqual(p25["service_max"], default["service_max"])

    def test_unknown_mode_is_rejected(self):
        with self.assertRaises(ValueError):
            compute_ocpa_metrics(log_with_sojourn_values([1]), service_time_mode="p75")


if __name__ == "__main__":
    unittest.main()
