# Decision Makers Finder

This Manifest V3 extension adds a floating **Find the Decision Makers** button to ordinary websites. It keeps the company website open, searches Google in one separate work tab, and processes configured queries sequentially.

From each Google result page it collects only `linkedin.com/in/<name>` profile links, removes duplicates, and then opens the profiles one at a time with a random 10–15 second gap. A Stop button remains visible across pages while the queue is running and disappears when it finishes. If Google requests human verification, the queue waits for it to be completed in the work tab.

The black popup provides an enable toggle, a one-query-per-line editor, progress text, and Start/Stop controls.
