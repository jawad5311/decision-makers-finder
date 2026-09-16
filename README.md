# Decision Makers Finder

This Manifest V3 extension adds a floating **Find the Decision Makers** button to ordinary websites. It keeps the company website open and searches Google in batches of up to three separate tabs.

From each Google result page it collects only `linkedin.com/in/<name>` profile links, removes duplicates, and then opens each profile in its own new tab with a random 10–15 second gap. A live unique-prospect count appears above the Stop button across eligible pages while the queue is running; the Stop button and count disappear when it finishes. If Google requests human verification, the queue waits for it to be completed in the relevant search tab.

The black popup provides an enable toggle, a one-query-per-line editor, progress text, and Start/Stop controls.
