// ---------------------------------------------------------------- storage
//
// Every read goes through these. A corrupt value, or a browser with storage
// blocked (private mode, "block third party data"), used to throw and take the
// whole page down with it.

function readStoredValue(key) {
    try {
        return localStorage.getItem(key);
    } catch (error) {
        console.error(`Storage is unavailable, cannot read "${key}":`, error);
        return null;
    }
}

function writeStoredValue(key, value) {
    try {
        localStorage.setItem(key, value);
        return true;
    } catch (error) {
        console.error(`Could not save "${key}":`, error);
        return false;
    }
}

function removeStoredValue(key) {
    try {
        localStorage.removeItem(key);
        return true;
    } catch (error) {
        console.error(`Could not clear "${key}":`, error);
        return false;
    }
}

function readStoredJSON(key, fallback) {
    const raw = readStoredValue(key);
    if (raw === null || raw === '') return fallback;
    try {
        const parsed = JSON.parse(raw);
        return (parsed === null || parsed === undefined) ? fallback : parsed;
    } catch (error) {
        console.error(`Stored value for "${key}" was corrupt and has been ignored:`, error);
        return fallback;
    }
}

function loadStoredBooks() {
    const stored = readStoredJSON('books', []);
    return Array.isArray(stored) ? stored : [];
}

// Returns false if the write failed, so callers can avoid telling the user
// their work was saved when it was not.
function writeStoredJSON(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
    } catch (error) {
        console.error(`Could not save "${key}":`, error);
        if (error && (error.name === 'QuotaExceededError' || error.code === 22)) {
            alert(
                'Your browser storage is full, so that change could not be saved.\n\n' +
                'Export your rankings from the Leaderboard, then use "Clear All Data" ' +
                'on the Upload page and re-import to free up space.'
            );
        } else {
            alert('That change could not be saved because browser storage is unavailable.');
        }
        return false;
    }
}

// Parse Goodreads CSV
async function parseGoodreadsCSV(file, existingBooks, progressCallback) {
    return new Promise((resolve, reject) => {
        Papa.parse(file, {
            header: true,
            skipEmptyLines: true,
            complete: async function (results) {
                try {
                    console.log('Parsing Goodreads CSV with', results.data.length, 'rows');
                    if (results.errors && results.errors.length > 0) {
                        console.warn('CSV Parsing Errors:', results.errors);
                    }

                    // Create maps using our book key function
                    const existingBooksMap = new Map();
                    existingBooks.forEach(book => {
                        const key = createBookKey(book);
                        existingBooksMap.set(key, book);
                    });

                    // Helper function to get number of pages from row, trying multiple column name variations
                    function getNumPages(row) {
                        const possibleColumns = [
                            "Number of Pages",
                            "Number Of Pages",
                            "Number of pages",
                            "Pages",
                            "Num Pages"
                        ];

                        for (const col of possibleColumns) {
                            const value = row[col];
                            if (value && value.toString().trim() !== '') {
                                const num = parseInt(value);
                                if (!isNaN(num) && num > 0) {
                                    return num;
                                }
                            }
                        }
                        return null;
                    }

                    // Identify books that are already read or currently reading
                    const booksInOtherShelves = new Set();
                    const activeShelves = new Set(['read', 'currently-reading']);

                    results.data.forEach(row => {
                        if (activeShelves.has(row["Exclusive Shelf"])) {
                            const title = (row["Title"] || '').toLowerCase().trim();
                            const author = (row["Author"] || '').toLowerCase().trim();
                            if (title && author) {
                                booksInOtherShelves.add(`${title}|${author}`);
                            }
                        }
                    });

                    const wantToReadBooks = [];

                    // Filter first to know total count for progress
                    const rowsToProcess = results.data.filter(row => row["Exclusive Shelf"] === "to-read");
                    // The read shelf is kept as well, parked and inactive, so a
                    // book can be ticked for a reread on the My Books page
                    // without re-importing anything.
                    const readRows = results.data.filter(row =>
                        row["Exclusive Shelf"] === "read" && String(row["Title"] || '').trim() !== ''
                    );
                    const totalToProcess = rowsToProcess.length;

                    if (progressCallback) progressCallback(`Found ${totalToProcess} books to process...`);

                    // Process rows quickly without waiting for covers
                    for (let i = 0; i < rowsToProcess.length; i++) {
                        const row = rowsToProcess[i];

                        // Check if this book (by title/author) is already in read/currently-reading
                        const title = (row["Title"] || '').toLowerCase().trim();
                        const author = (row["Author"] || '').toLowerCase().trim();
                        const key = `${title}|${author}`;

                        if (booksInOtherShelves.has(key)) {
                            console.log(`Skipping "${row["Title"]}" because it is also in read/currently-reading`);
                            continue;
                        }

                        const bookKey = createBookKey(row);
                        const existingBook = existingBooksMap.get(bookKey);
                        const isbn = cleanISBN(row["ISBN13"]) || cleanISBN(row["ISBN"]);
                        const numPages = getNumPages(row);

                        if (existingBook) {
                            wantToReadBooks.push({
                                ...existingBook,
                                title: row["Title"] || existingBook.title,
                                author: row["Author"] || existingBook.author,
                                isbn: isbn || existingBook.isbn,
                                // Keep existing cover, or set OpenLibrary fallback if none exists and we have ISBN
                                cover_url: existingBook.cover_url ||
                                    (isbn ? `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg` : null),
                                num_pages: numPages !== null ? numPages : (existingBook.num_pages || null),
                                additional_authors: row["Additional Authors"] || existingBook.additional_authors,
                                average_rating: row["Average Rating"] || existingBook.average_rating,
                                publisher: row["Publisher"] || existingBook.publisher,
                                year_published: row["Year Published"] || existingBook.year_published,
                                original_publication_year: row["Original Publication Year"] || existingBook.original_publication_year,
                                date_added: row["Date Added"] || existingBook.date_added,
                                source: existingBook.source || 'goodreads',
                                shelf: 'to-read',
                                active: 1
                            });
                        } else {
                            // New book - Set OpenLibrary as placeholder if ISBN exists, else null
                            // We will fetch better covers in the background
                            let coverUrl = isbn ? `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg` : null;

                            wantToReadBooks.push({
                                id: generateUniqueId(),
                                isbn: isbn,
                                title: row["Title"] || "Unknown Title",
                                author: row["Author"] || "Unknown Author",
                                cover_url: coverUrl,
                                num_pages: numPages,
                                additional_authors: row["Additional Authors"] || '',
                                average_rating: row["Average Rating"] || '',
                                publisher: row["Publisher"] || '',
                                year_published: row["Year Published"] || '',
                                original_publication_year: row["Original Publication Year"] || '',
                                date_added: row["Date Added"] || '',
                                notes: '',
                                link: '',
                                elo: 1500,
                                matchups: 0,
                                source: 'goodreads',
                                shelf: 'to-read',
                                active: 1
                            });
                        }
                    }

                    console.log('Found', wantToReadBooks.length, 'want to read books');

                    const readBooks = readRows.map(row => {
                        const isbn = cleanISBN(row["ISBN13"]) || cleanISBN(row["ISBN"]);
                        const existingBook = existingBooksMap.get(createBookKey(row));
                        const numPages = getNumPages(row);

                        if (existingBook) {
                            return {
                                ...existingBook,
                                title: row["Title"] || existingBook.title,
                                author: row["Author"] || existingBook.author,
                                isbn: isbn || existingBook.isbn,
                                num_pages: numPages !== null ? numPages : (existingBook.num_pages || null),
                                publisher: row["Publisher"] || existingBook.publisher,
                                year_published: row["Year Published"] || existingBook.year_published,
                                date_added: row["Date Added"] || existingBook.date_added,
                                source: existingBook.source || 'goodreads',
                                shelf: 'read',
                                // Preserve a reread the reader has already ticked.
                                active: existingBook.active === 1 && existingBook.shelf === 'read' ? 1 : 0
                            };
                        }

                        return {
                            id: generateUniqueId(),
                            isbn: isbn,
                            title: row["Title"],
                            author: row["Author"] || 'Unknown Author',
                            cover_url: isbn ? `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg` : null,
                            num_pages: numPages,
                            additional_authors: row["Additional Authors"] || '',
                            average_rating: row["Average Rating"] || '',
                            publisher: row["Publisher"] || '',
                            year_published: row["Year Published"] || '',
                            original_publication_year: row["Original Publication Year"] || '',
                            date_added: row["Date Added"] || '',
                            date_read: row["Date Read"] || '',
                            my_rating: row["My Rating"] || '',
                            notes: '',
                            link: '',
                            elo: 1500,
                            matchups: 0,
                            source: 'goodreads',
                            shelf: 'read',
                            active: 0
                        };
                    });

                    console.log('Found', readBooks.length, 'books on the read shelf');

                    // Create a map of new books using our key function. Read
                    // books are included so the archive sweep below leaves them
                    // alone.
                    const newBooksMap = new Map(
                        wantToReadBooks.concat(readBooks).map(book => [createBookKey(book), book])
                    );

                    // Books missing from this import are archived, but only if
                    // they came from this library. A Goodreads import must not
                    // archive your StoryGraph books or the ones you added by hand.
                    const inactiveBooks = existingBooks
                        .filter(book => !newBooksMap.has(createBookKey(book)))
                        .map(book => archiveIfOwnedBy(book, 'goodreads'));

                    const mergedBooks = [...wantToReadBooks, ...readBooks, ...inactiveBooks];
                    console.log('Final merged book count:', mergedBooks.length);

                    resolve(mergedBooks);
                } catch (error) {
                    console.error('Error processing Goodreads data:', error);
                    reject(error);
                }
            },
            error: function (error) {
                console.error('CSV parsing error:', error);
                reject(error);
            }
        });
    });
}

// Records that predate source tracking came from Goodreads, the only
// importer that existed at the time.
function bookSource(book) {
    return book.source || 'goodreads';
}

function archiveIfOwnedBy(book, source) {
    if (bookSource(book) !== source) return book;   // another library owns it
    if (book.shelf === 'read') return book;         // parked, not on the to-read shelf
    console.log(`Marking as inactive: "${book.title}" by ${book.author}`);
    return { ...book, active: 0 };
}

// cleanISBN only strips characters, so a StoryGraph UUID would survive it as a
// long meaningless digit string and then get used as a book key. This insists
// on something ISBN shaped.
function normaliseIsbn(raw) {
    const cleaned = cleanISBN(raw);
    if (!cleaned) return null;
    return /^\d{9}[\dX]$|^\d{13}$/.test(cleaned) ? cleaned : null;
}

// Read just the header row, so the upload page can accept either library
// through a single file input.
function detectCsvType(file) {
    return new Promise((resolve, reject) => {
        Papa.parse(file, {
            header: true,
            preview: 1,
            skipEmptyLines: true,
            complete: function (results) {
                const headers = (results.meta && results.meta.fields) ||
                                (results.data[0] ? Object.keys(results.data[0]) : []);
                const has = name => headers.indexOf(name) !== -1;

                if (has('Read Status') || has('ISBN/UID')) return resolve('storygraph');
                if (has('Exclusive Shelf') || has('Bookshelves') || has('Book Id')) return resolve('goodreads');
                if (has('ELO') || has('Elo')) return resolve('rankings');
                resolve('unknown');
            },
            error: function (error) { reject(error); }
        });
    });
}

// Parse StoryGraph CSV
//
// One row per book, with the shelf in "Read Status" rather than a shelf column.
// "ISBN/UID" holds an ISBN for most books and an internal UUID for the rest.
async function parseStorygraphCSV(file, existingBooks, progressCallback) {
    return new Promise((resolve, reject) => {
        Papa.parse(file, {
            header: true,
            skipEmptyLines: true,
            complete: function (results) {
                try {
                    console.log('Parsing StoryGraph CSV with', results.data.length, 'rows');
                    if (results.errors && results.errors.length > 0) {
                        console.warn('CSV Parsing Errors:', results.errors);
                    }

                    const existingBooksMap = new Map();
                    existingBooks.forEach(book => {
                        existingBooksMap.set(createBookKey(book), book);
                    });

                    const readStatus = row => String(row['Read Status'] || '').trim().toLowerCase();
                    const hasTitle = row => String(row['Title'] || '').trim() !== '';

                    const rowsToProcess = results.data.filter(row => readStatus(row) === 'to-read' && hasTitle(row));
                    const readRows = results.data.filter(row => readStatus(row) === 'read' && hasTitle(row));

                    if (progressCallback) progressCallback(`Found ${rowsToProcess.length} books to process...`);

                    const wantToReadBooks = rowsToProcess.map(row => {
                        const isbn = normaliseIsbn(row['ISBN/UID']);
                        const title = row['Title'] || 'Unknown Title';
                        const author = row['Authors'] || row['Contributors'] || 'Unknown Author';
                        const existingBook = existingBooksMap.get(createBookKey({ isbn, title, author }));

                        if (existingBook) {
                            return {
                                ...existingBook,
                                title: title,
                                author: author,
                                isbn: isbn || existingBook.isbn,
                                cover_url: existingBook.cover_url ||
                                    (isbn ? `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg` : null),
                                date_added: row['Date Added'] || existingBook.date_added,
                                // StoryGraph carries no page count, publisher or
                                // year, so anything already known is kept.
                                format: row['Format'] || existingBook.format || '',
                                tags: row['Tags'] || existingBook.tags || '',
                                source: existingBook.source || 'storygraph',
                                shelf: 'to-read',
                                active: 1
                            };
                        }

                        return {
                            id: generateUniqueId(),
                            isbn: isbn,
                            title: title,
                            author: author,
                            cover_url: isbn ? `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg` : null,
                            num_pages: null,
                            additional_authors: row['Contributors'] || '',
                            average_rating: '',
                            publisher: '',
                            year_published: '',
                            original_publication_year: '',
                            date_added: row['Date Added'] || '',
                            format: row['Format'] || '',
                            tags: row['Tags'] || '',
                            notes: '',
                            link: '',
                            elo: 1500,
                            matchups: 0,
                            source: 'storygraph',
                            shelf: 'to-read',
                            active: 1
                        };
                    });

                    const readBooks = readRows.map(row => {
                        const isbn = normaliseIsbn(row['ISBN/UID']);
                        const title = row['Title'];
                        const author = row['Authors'] || row['Contributors'] || 'Unknown Author';
                        const existingBook = existingBooksMap.get(createBookKey({ isbn, title, author }));

                        if (existingBook) {
                            return {
                                ...existingBook,
                                title: title,
                                author: author,
                                isbn: isbn || existingBook.isbn,
                                format: row['Format'] || existingBook.format || '',
                                tags: row['Tags'] || existingBook.tags || '',
                                source: existingBook.source || 'storygraph',
                                shelf: 'read',
                                active: existingBook.active === 1 && existingBook.shelf === 'read' ? 1 : 0
                            };
                        }

                        return {
                            id: generateUniqueId(),
                            isbn: isbn,
                            title: title,
                            author: author,
                            cover_url: isbn ? `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg` : null,
                            num_pages: null,
                            additional_authors: row['Contributors'] || '',
                            average_rating: '',
                            publisher: '',
                            year_published: '',
                            original_publication_year: '',
                            date_added: row['Date Added'] || '',
                            date_read: row['Last Date Read'] || '',
                            my_rating: row['Star Rating'] || '',
                            format: row['Format'] || '',
                            tags: row['Tags'] || '',
                            notes: '',
                            link: '',
                            elo: 1500,
                            matchups: 0,
                            source: 'storygraph',
                            shelf: 'read',
                            active: 0
                        };
                    });

                    console.log('Found', readBooks.length, 'books on the read shelf');

                    console.log('Found', wantToReadBooks.length, 'want to read books');

                    const newBooksMap = new Map(
                        wantToReadBooks.concat(readBooks).map(book => [createBookKey(book), book])
                    );

                    const inactiveBooks = existingBooks
                        .filter(book => !newBooksMap.has(createBookKey(book)))
                        .map(book => archiveIfOwnedBy(book, 'storygraph'));

                    const mergedBooks = [...wantToReadBooks, ...readBooks, ...inactiveBooks];
                    console.log('Final merged book count:', mergedBooks.length);
                    resolve(mergedBooks);
                } catch (error) {
                    console.error('Error processing StoryGraph data:', error);
                    reject(error);
                }
            },
            error: function (error) {
                console.error('CSV parsing error:', error);
                reject(error);
            }
        });
    });
}

// Read a library export of either flavour, detecting which it is.
async function parseLibraryCSV(file, existingBooks, progressCallback) {
    const kind = await detectCsvType(file);

    if (kind === 'goodreads') {
        return { kind, books: await parseGoodreadsCSV(file, existingBooks, progressCallback) };
    }
    if (kind === 'storygraph') {
        return { kind, books: await parseStorygraphCSV(file, existingBooks, progressCallback) };
    }
    if (kind === 'rankings') {
        throw new Error('That looks like a rankings CSV. Please choose it in the "Previous Rankings CSV" box instead.');
    }
    throw new Error('Unrecognised CSV. Expected a Goodreads or StoryGraph library export.');
}

// ------------------------------------------------- custom books and notes

// Books added by hand, rather than coming from a library export. They carry
// source 'custom', which keeps them out of the archive sweep an import does.

function addCustomBook(fields) {
    const title = String(fields.title || '').trim();
    if (!title) return { added: false, reason: 'A title is required.', book: null };

    const candidate = {
        id: generateUniqueId(),
        isbn: normaliseIsbn(fields.isbn),
        title: title,
        author: String(fields.author || '').trim() || 'Unknown Author',
        cover_url: String(fields.cover_url || '').trim() ||
            (normaliseIsbn(fields.isbn) ? `https://covers.openlibrary.org/b/isbn/${normaliseIsbn(fields.isbn)}-L.jpg` : null),
        num_pages: null,
        additional_authors: '',
        average_rating: '',
        publisher: '',
        year_published: '',
        original_publication_year: '',
        date_added: new Date().toISOString().slice(0, 10),
        notes: String(fields.notes || '').trim(),
        link: String(fields.link || '').trim(),
        elo: 1500,
        matchups: 0,
        source: 'custom',
        active: 1
    };

    const key = createBookKey(candidate);
    const existing = books.find(book => createBookKey(book) === key);
    if (existing) return { added: false, reason: 'already in your library', book: existing };

    books.push(candidate);
    return saveBooks()
        ? { added: true, book: candidate }
        : { added: false, reason: 'could not be saved', book: null };
}

const EDITABLE_BOOK_FIELDS = ['title', 'author', 'cover_url', 'notes', 'link'];

function updateBookFields(bookId, changes) {
    const book = books.find(b => b.id === bookId);
    if (!book) return false;

    EDITABLE_BOOK_FIELDS.forEach(field => {
        if (!Object.prototype.hasOwnProperty.call(changes, field)) return;
        book[field] = String(changes[field] === null || changes[field] === undefined ? '' : changes[field]).trim();
    });
    if (Object.prototype.hasOwnProperty.call(changes, 'isbn')) {
        book.isbn = normaliseIsbn(changes.isbn);
    }
    if (Object.prototype.hasOwnProperty.call(changes, 'active')) {
        book.active = Number(changes.active) === 0 ? 0 : 1;
    }
    if (!book.title) book.title = 'Unknown Title';
    return saveBooks();
}

function setBookActive(bookId, active) {
    return updateBookFields(bookId, { active: active });
}

function deleteBook(bookId) {
    const before = books.length;
    const remaining = books.filter(b => b.id !== bookId);
    if (remaining.length === before) return false;
    books.length = 0;
    remaining.forEach(b => books.push(b));
    return saveBooks();
}

// ------------------------------------------------------------- bulk adding

// Royal Road and similar sites cannot be read from the browser: no public API
// and no CORS headers, so a fetch from this origin is blocked before it is
// sent. A pasted link is therefore turned into a title from its slug, with the
// link kept so it stays clickable.
function titleFromUrl(url) {
    let path = url;
    try {
        path = new URL(url).pathname;
    } catch (error) {
        // Not a parseable URL; treat the whole string as a path.
    }
    const segments = path.split('/').filter(Boolean);
    let slug = '';
    for (let i = segments.length - 1; i >= 0; i--) {
        if (!/^\d+$/.test(segments[i])) { slug = segments[i]; break; }
    }
    if (!slug) return '';
    return slug
        .replace(/\.[a-z0-9]{1,5}$/i, '')
        .replace(/[-_+]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\b\w/g, c => c.toUpperCase());
}

// One book per line:
//   Title
//   Title | Author
//   Title | Author | Cover image URL
//   https://www.royalroad.com/fiction/12345/some-story
// Tabs work as separators too, so a spreadsheet column pastes straight in.
// Blank lines and lines starting with # are ignored.
function parseBulkInput(text) {
    const entries = [];
    const skipped = [];

    String(text || '').split(/\r?\n/).forEach(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.charAt(0) === '#') return;

        if (/^https?:\/\//i.test(trimmed)) {
            const derived = titleFromUrl(trimmed);
            if (!derived) { skipped.push(trimmed); return; }
            entries.push({ title: derived, author: '', cover_url: '', link: trimmed });
            return;
        }

        const parts = trimmed.split(/\s*[|\t]\s*/);
        const title = (parts[0] || '').trim();
        if (!title) { skipped.push(trimmed); return; }

        const rest = parts.slice(1).map(p => p.trim()).filter(Boolean);
        const cover = rest.find(p => /^https?:\/\//i.test(p) && /\.(jpe?g|png|webp|gif|avif)(\?|$)/i.test(p)) || '';
        const link = rest.find(p => /^https?:\/\//i.test(p) && p !== cover) || '';
        const author = rest.find(p => !/^https?:\/\//i.test(p)) || '';

        entries.push({ title: title, author: author, cover_url: cover, link: link });
    });

    return { entries: entries, skipped: skipped };
}

// Adds many at once, skipping any already present, and saving once at the end
// rather than per book.
function addBooksBulk(entries) {
    const added = [];
    const duplicates = [];

    entries.forEach(entry => {
        const title = String(entry.title || '').trim();
        if (!title) return;

        const candidate = {
            id: generateUniqueId(),
            isbn: null,
            title: title,
            author: String(entry.author || '').trim() || 'Unknown Author',
            cover_url: String(entry.cover_url || '').trim() || null,
            num_pages: null,
            additional_authors: '',
            average_rating: '',
            publisher: '',
            year_published: '',
            original_publication_year: '',
            date_added: new Date().toISOString().slice(0, 10),
            notes: String(entry.notes || '').trim(),
            link: String(entry.link || '').trim(),
            elo: 1500,
            matchups: 0,
            source: 'custom',
            active: 1
        };

        const key = createBookKey(candidate);
        if (books.some(book => createBookKey(book) === key)) { duplicates.push(title); return; }
        books.push(candidate);
        added.push(candidate);
    });

    const saved = saveBooks();
    return { added: saved ? added.length : 0, duplicates: duplicates, saved: saved };
}

// Rough size of what is stored, for the warning on the manage page.
function storageUsage() {
    const raw = readStoredValue('books') || '';
    return { bytes: raw.length, books: books.length };
}

// Background Cover Fetcher
let isFetchingCover = false;

// Helper to check if an image is a 1x1 pixel placeholder or fails to load
function isImageBroken(url) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = function () {
            // OpenLibrary returns 1x1 pixel GIF for missing covers
            if (this.naturalWidth <= 1 && this.naturalHeight <= 1) {
                resolve(true);
            } else {
                resolve(false);
            }
        };
        img.onerror = function () {
            resolve(true);
        };
        img.src = url;
    });
}

async function fetchMissingCoverForBook(book) {
    if (!book || isFetchingCover) return false;

    // Check if we should fetch a better cover
    // 1. If no cover (null/empty) -> Fetch
    // 2. If OpenLibrary ISBN-based cover -> Check if it's broken. If broken -> Try search. If good -> Keep.
    // 3. If OpenLibrary search-based cover (has /id/ in URL) -> Skip (already searched)
    // 4. If marked as failed -> Skip (already tried and failed)
    const hasNoCover = !book.cover_url;
    const hasIsbnCover = book.cover_url && book.cover_url.includes('/isbn/');
    const hasSearchCover = book.cover_url && book.cover_url.includes('/id/');
    const hasFailedBefore = book.cover_fetch_failed === true;

    // Skip if already has a search-based cover or marked as failed
    if (hasSearchCover || hasFailedBefore) return false;

    // Skip if has a valid ISBN-based cover
    if (hasIsbnCover) {
        const isBroken = await isImageBroken(book.cover_url);
        if (!isBroken) {
            // It's a valid image, keep it
            return false;
        }
        console.log(`ISBN cover for "${book.title}" is missing/placeholder, searching OpenLibrary...`);
    }

    isFetchingCover = true;
    console.log(`Background fetching cover for: ${book.title}`);

    try {
        // Try OpenLibrary first, then Google Books as fallback
        const newCoverUrl = await fetchBookCover(book.title, book.author, book.isbn);

        const bookIndex = books.findIndex(b => b.id === book.id);
        if (bookIndex !== -1) {
            if (newCoverUrl) {
                books[bookIndex].cover_url = newCoverUrl;
                books[bookIndex].cover_fetch_failed = false;
                saveBooks();
                console.log(`Updated cover for ${book.title}`);

                // Dispatch event so UI can update if needed
                window.dispatchEvent(new CustomEvent('bookCoverUpdated', {
                    detail: { bookId: book.id, coverUrl: newCoverUrl }
                }));
                return true;
            } else {
                // Mark as failed so we don't keep retrying
                books[bookIndex].cover_fetch_failed = true;
                books[bookIndex].cover_url = null; // Clear the broken cover URL
                saveBooks();
                console.log(`No valid cover found for "${book.title}", marked as failed`);

                // Dispatch event so UI can show placeholder
                window.dispatchEvent(new CustomEvent('bookCoverUpdated', {
                    detail: { bookId: book.id, coverUrl: null, failed: true }
                }));
            }
        }
    } catch (e) {
        console.warn(`Error background fetching for ${book.title}:`, e);
    } finally {
        isFetchingCover = false;
    }
    return false;
}

// ------------------------------------------------------ metadata back-fill
//
// A StoryGraph export carries no page count, publisher or year, and records
// saved by very old versions have none either, so the ranking line loses its
// "| 384 pages" and the info popup has nothing to show. These are filled in
// from the same APIs the cover fetcher already uses.

function bookNeedsMetadata(book) {
    if (!book || book.metadata_fetch_failed) return false;
    const missingPages = book.num_pages === null || book.num_pages === undefined || book.num_pages === '';
    return missingPages && Boolean(book.title);
}

async function fetchBookMetadata(title, author, isbn) {
    const query = isbn
        ? `isbn:${isbn}`
        : `intitle:${encodeURIComponent(title)}${author ? '+inauthor:' + encodeURIComponent(author) : ''}`;

    try {
        const response = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${query}&maxResults=5`);
        if (!response.ok) return null;
        const data = await response.json();
        if (!data.items || !data.items.length) return null;

        const normalize = text => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        const wantedTitle = normalize(title);

        for (const item of data.items) {
            const info = item.volumeInfo;
            if (!info) continue;

            // With no ISBN to pin it down, only trust a result whose title
            // actually matches, or the page count could belong to another book.
            if (!isbn) {
                const resultTitle = normalize(info.title);
                const matches = resultTitle === wantedTitle ||
                    resultTitle.indexOf(wantedTitle) === 0 ||
                    wantedTitle.indexOf(resultTitle) === 0;
                if (!matches) continue;
            }

            const pages = Number(info.pageCount);
            const year = info.publishedDate ? String(info.publishedDate).slice(0, 4) : '';
            if (!pages && !info.publisher && !year) continue;

            return {
                num_pages: Number.isFinite(pages) && pages > 0 ? pages : null,
                publisher: info.publisher || '',
                year_published: year
            };
        }
        return null;
    } catch (error) {
        console.warn(`Failed to fetch metadata for "${title}":`, error);
        return null;
    }
}

async function fetchMissingMetadataForBook(book) {
    if (!bookNeedsMetadata(book) || isFetchingCover) return false;

    isFetchingCover = true;   // shares the lock, so only one request is in flight
    try {
        const found = await fetchBookMetadata(book.title, book.author, book.isbn);
        const index = books.findIndex(b => b.id === book.id);
        if (index === -1) return false;

        if (!found) {
            books[index].metadata_fetch_failed = true;
            saveBooks();
            return false;
        }

        if (found.num_pages) books[index].num_pages = found.num_pages;
        if (found.publisher && !books[index].publisher) books[index].publisher = found.publisher;
        if (found.year_published && !books[index].year_published) books[index].year_published = found.year_published;
        // Nothing usable came back, so do not ask again.
        if (!found.num_pages) books[index].metadata_fetch_failed = true;
        saveBooks();

        window.dispatchEvent(new CustomEvent('bookMetadataUpdated', {
            detail: { bookId: book.id, book: books[index] }
        }));
        return true;
    } catch (error) {
        console.warn(`Error back-filling metadata for ${book.title}:`, error);
        return false;
    } finally {
        isFetchingCover = false;
    }
}

function startBackgroundCoverFetcher() {
    // Run every 2 seconds
    setInterval(async () => {
        if (isFetchingCover) return;

        // Find a random active book that needs a cover
        const activeBooks = books.filter(b => b.active === 1);
        // Include books with no cover OR books with ISBN-based covers (which might be broken)
        // Exclude books that have already been searched (have /id/ URL) or marked as failed
        const booksNeedingCover = activeBooks.filter(b =>
            !b.cover_fetch_failed &&
            !b.cover_url?.includes('/id/') &&  // Already searched via OpenLibrary
            (!b.cover_url || b.cover_url.includes('/isbn/'))  // No cover or ISBN cover that might be broken
        );

        if (booksNeedingCover.length > 0) {
            const randomBook = booksNeedingCover[Math.floor(Math.random() * booksNeedingCover.length)];
            await fetchMissingCoverForBook(randomBook);
            return;
        }

        // Covers are all settled, so start filling in the missing page counts.
        const booksNeedingMetadata = activeBooks.filter(bookNeedsMetadata);
        if (booksNeedingMetadata.length > 0) {
            const randomBook = booksNeedingMetadata[Math.floor(Math.random() * booksNeedingMetadata.length)];
            await fetchMissingMetadataForBook(randomBook);
        }
    }, 2000);
}

// Start the background fetcher when app.js loads
// (It will run on any page that includes app.js)
startBackgroundCoverFetcher();

// Parse Rankings CSV
async function parseRankingsCSV(file, existingBooks) {
    return new Promise((resolve, reject) => {
        Papa.parse(file, {
            header: true,
            skipEmptyLines: true,
            complete: function (results) {
                try {
                    console.log('Parsing Rankings CSV with', results.data.length, 'rows');

                    // Create a map of existing books by key
                    const existingBooksMap = new Map();
                    existingBooks.forEach(book => {
                        const key = createBookKey(book);
                        existingBooksMap.set(key, book);
                    });

                    // Update existing books with ranking data
                    const restored = [];

                    results.data.forEach(row => {
                        const key = createBookKey(row);
                        const book = existingBooksMap.get(key);

                        if (book) {
                            book.elo = parseFloat(row["ELO"]) || 1500;
                            book.matchups = parseInt(row["Matchups"]) || 0;
                            // Compared explicitly: parseInt("0") is falsy, so a
                            // "|| 1" here would un-archive every archived book.
                            if (row["Active"] !== undefined && String(row["Active"]).trim() !== '') {
                                book.active = parseInt(row["Active"]) === 0 ? 0 : 1;
                            }
                            // Only ever fill notes in. A CSV without the column
                            // must not wipe notes already written.
                            if (row["Notes"]) book.notes = row["Notes"];
                            if (row["Link"]) book.link = row["Link"];
                            return;
                        }

                        // A book added by hand lives only in this CSV, so it is
                        // recreated rather than dropped. Library books are left
                        // alone: they come back from a library export.
                        if (String(row["Source"] || '').trim() === 'custom' && String(row["Title"] || '').trim()) {
                            restored.push({
                                id: generateUniqueId(),
                                isbn: normaliseIsbn(row["ISBN13"] || row["ISBN"]),
                                title: row["Title"],
                                author: row["Author"] || 'Unknown Author',
                                cover_url: row["Cover URL"] || null,
                                num_pages: null,
                                additional_authors: '',
                                average_rating: '',
                                publisher: '',
                                year_published: '',
                                original_publication_year: '',
                                date_added: row["Date Added"] || '',
                                notes: row["Notes"] || '',
                                link: row["Link"] || '',
                                elo: parseFloat(row["ELO"]) || 1500,
                                matchups: parseInt(row["Matchups"]) || 0,
                                source: 'custom',
                                active: parseInt(row["Active"]) === 0 ? 0 : 1
                            });
                        }
                    });

                    if (restored.length) console.log('Restored', restored.length, 'custom books from the rankings CSV');
                    resolve(existingBooks.concat(restored));
                } catch (error) {
                    console.error('Error processing Rankings data:', error);
                    reject(error);
                }
            },
            error: function (error) {
                console.error('CSV parsing error:', error);
                reject(error);
            }
        });
    });
}

// Generate CSV for export
function generateCSV(books) {
    const data = books.map(book => ({
        "Title": book.title,
        "Author": book.author,
        "ISBN": book.isbn,
        "ISBN13": book.isbn,
        "ELO": Math.round(book.elo),
        "Matchups": book.matchups,
        "Number of Pages": book.num_pages,
        "Additional Authors": book.additional_authors,
        "Average Rating": book.average_rating,
        "Publisher": book.publisher,
        "Year Published": book.year_published,
        "Original Publication Year": book.original_publication_year,
        "Date Added": book.date_added,
        "Source": book.source || 'goodreads',
        "Active": book.active === 0 ? 0 : 1,
        "Notes": book.notes || '',
        "Link": book.link || '',
        "Cover URL": book.cover_url || ''
    }));

    return Papa.unparse(data);
}

// Helper to clean ISBN
function cleanISBN(isbn) {
    if (!isbn) return null;
    // Remove non-numeric characters except 'X'
    return isbn.replace(/[^0-9X]/g, '');
}

// Helper to create a unique key for a book
function createBookKey(book) {
    // Create a key using ISBN or title+author if ISBN is missing
    // Fix: Try each field individually to ensure we get a valid ISBN if one exists
    const isbn = cleanISBN(book.isbn) || cleanISBN(book.ISBN13) || cleanISBN(book.ISBN);
    if (isbn) return isbn;

    // Fallback to title+author combination
    const title = (book.title || book.Title || '').toLowerCase().trim();
    const author = (book.author || book.Author || '').toLowerCase().trim();
    return `${title}|${author}`;
}

// Helper to generate unique ID
function generateUniqueId() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2);
}

// Update book ELO
function updateBookElo(bookId, newElo) {
    const bookIndex = books.findIndex(b => b.id === bookId);
    if (bookIndex !== -1) {
        books[bookIndex].elo = newElo;
        books[bookIndex].matchups = (books[bookIndex].matchups || 0) + 1;
        saveBooks();
    }
}

// Get next matchup data
function getNextMatchupData(options = {}) {
    let activeBooks = books.filter(b => b.active === 1);

    // Apply limit filter if enabled
    if (options.limitEnabled && options.limitValue) {
        // Sort by ELO descending
        const sortedBooks = [...activeBooks].sort((a, b) => b.elo - a.elo);

        let limit = parseInt(options.limitValue);
        if (options.limitType === 'percent') {
            limit = Math.ceil(sortedBooks.length * (limit / 100));
        }

        // Take top N books
        // We filter the activeBooks list to only include those in the top N
        // This allows the rest of the logic (lowest matchups, etc.) to work on the limited pool
        const topBooksSet = new Set(sortedBooks.slice(0, Math.max(2, limit)).map(b => b.id));
        activeBooks = activeBooks.filter(b => topBooksSet.has(b.id));
    }

    if (activeBooks.length < 2) return { book1: null, book2: null };

    // 1. Pick Book 1 (Prioritize lowest matchups)
    // Find the minimum number of matchups any book has
    const minMatchups = Math.min(...activeBooks.map(b => b.matchups || 0));

    // Define "low matchups" pool (within 2 of the minimum)
    // This ensures we focus on books that need ranking the most
    const lowMatchupPool = activeBooks.filter(b => (b.matchups || 0) <= minMatchups + 2);

    // If we have books in the low matchup pool, pick one randomly. Otherwise pick any active book.
    const pool1 = lowMatchupPool.length > 0 ? lowMatchupPool : activeBooks;
    const book1 = pool1[Math.floor(Math.random() * pool1.length)];

    // 2. Pick Book 2
    // Candidates are all other active books excluding Book 1
    let candidates = activeBooks.filter(b => b.id !== book1.id);

    // Constraint 1: Avoid "New vs New" loops
    // If Book 1 is "new" (low matchups) and the pool of such books is small (< 20),
    // try to pick an opponent that is established (has more matchups).
    // This satisfies the user request: "only one of the books need to come from that smaller pool"
    const NEW_BOOK_THRESHOLD = 5;
    const SMALL_POOL_SIZE = 20;

    if ((book1.matchups || 0) < NEW_BOOK_THRESHOLD && lowMatchupPool.length < SMALL_POOL_SIZE) {
        const establishedCandidates = candidates.filter(b => (b.matchups || 0) >= NEW_BOOK_THRESHOLD);
        // Only switch to established candidates if any exist
        if (establishedCandidates.length > 0) {
            candidates = establishedCandidates;
        }
    }

    // Constraint 2: Similar ELO
    // Sort candidates by ELO difference (closest to Book 1 first)
    candidates.sort((a, b) => Math.abs(a.elo - book1.elo) - Math.abs(b.elo - book1.elo));

    // Pick from the top N closest matches to add some variety and avoid exact repeats
    // We take the top 5 or top 10% of candidates, whichever is larger
    const topN = Math.max(5, Math.ceil(candidates.length * 0.1));
    const bestCandidates = candidates.slice(0, topN);

    const book2 = bestCandidates[Math.floor(Math.random() * bestCandidates.length)];

    return { book1, book2 };
}

// Helper to ensure covers are fetched for the current matchup
async function ensureMatchupCovers(book1, book2) {
    if (book1) await fetchMissingCoverForBook(book1);
    if (book2) await fetchMissingCoverForBook(book2);
}

// Fetch cover from OpenLibrary using their Search API
// This finds books by title/author when ISBN lookup fails
async function fetchCoverFromOpenLibrary(title, author, isbn) {
    // Strategy:
    // 1. If ISBN exists, try the direct ISBN cover URL first
    // 2. If that fails (or no ISBN), use the Search API to find the book
    // 3. Get the cover_i (cover ID) from search results
    // 4. Construct cover URL from cover ID

    // Try ISBN first (most reliable)
    if (isbn) {
        const isbnUrl = `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg`;
        const isBroken = await isImageBroken(isbnUrl);
        if (!isBroken) {
            console.log(`Found cover via ISBN for "${title}"`);
            return isbnUrl;
        }
    }

    // Clean title for search - remove series info in parentheses
    const cleanTitle = title ? title.replace(/\s*\(.*?\)\s*/g, '').trim() : '';
    if (!cleanTitle) return null;

    // Try OpenLibrary Search API with title and author parameters
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

        // Use title and author parameters for better matching
        let searchUrl = `https://openlibrary.org/search.json?title=${encodeURIComponent(cleanTitle)}`;
        if (author) {
            searchUrl += `&author=${encodeURIComponent(author)}`;
        }
        searchUrl += '&limit=10&fields=title,author_name,cover_i';

        console.log(`Searching OpenLibrary: ${searchUrl}`);

        const response = await fetch(searchUrl, { signal: controller.signal });
        clearTimeout(timeoutId);

        if (!response.ok) {
            console.warn(`OpenLibrary search failed with status ${response.status}`);
            return null;
        }

        const data = await response.json();
        console.log(`OpenLibrary returned ${data.docs?.length || 0} results for "${cleanTitle}"`);

        if (!data.docs || data.docs.length === 0) return null;

        // Helper to normalize text for matching
        const normalize = (t) => (t || '').toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
        const expectedTitleNorm = normalize(cleanTitle);
        const expectedAuthorNorm = normalize(author);
        const expectedAuthorWords = expectedAuthorNorm.split(' ').filter(w => w.length > 2);

        // Find first result that matches title AND author
        for (const doc of data.docs) {
            if (!doc.cover_i) continue;

            const resultTitleNorm = normalize(doc.title);

            // STRICT title check: require full containment
            const titleMatches = resultTitleNorm.includes(expectedTitleNorm) ||
                expectedTitleNorm.includes(resultTitleNorm) ||
                resultTitleNorm === expectedTitleNorm;

            if (!titleMatches) {
                console.log(`Skipping OpenLibrary "${doc.title}" - title doesn't match "${cleanTitle}"`);
                continue;
            }

            // Author check: at least one significant word must match
            const resultAuthors = doc.author_name ? doc.author_name.join(' ') : '';
            const resultAuthorNorm = normalize(resultAuthors);

            let authorMatches = false;
            if (!author || expectedAuthorWords.length === 0) {
                // No author to check, accept based on title alone
                authorMatches = true;
            } else {
                // Check if any author word appears
                for (const word of expectedAuthorWords) {
                    if (resultAuthorNorm.includes(word)) {
                        authorMatches = true;
                        break;
                    }
                }
            }

            if (!authorMatches) {
                console.log(`Skipping OpenLibrary "${doc.title}" by ${resultAuthors} - author doesn't match "${author}"`);
                continue;
            }

            const coverUrl = `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`;

            // Verify the cover actually loads
            const isBroken = await isImageBroken(coverUrl);
            if (!isBroken) {
                console.log(`Found cover for "${title}" -> "${doc.title}" by ${resultAuthors}`);
                return coverUrl;
            }
        }

        console.log(`No matching result with valid cover found for "${title}" by ${author}`);
        return null;
    } catch (e) {
        if (e.name === 'AbortError') {
            console.warn(`OpenLibrary search timed out for "${title}"`);
        } else {
            console.warn(`Failed to fetch cover from OpenLibrary for "${title}":`, e);
        }
        return null;
    }
}

// Fallback: Fetch cover from Google Books API
async function fetchCoverFromGoogleBooks(title, author) {
    const cleanTitle = title ? title.replace(/\s*\(.*?\)\s*/g, '').trim() : '';
    if (!cleanTitle) return null;

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);

        // Build query with title and author
        let query = `intitle:${encodeURIComponent(cleanTitle)}`;
        if (author) {
            query += `+inauthor:${encodeURIComponent(author)}`;
        }

        const response = await fetch(
            `https://www.googleapis.com/books/v1/volumes?q=${query}&maxResults=10`,
            { signal: controller.signal }
        );
        clearTimeout(timeoutId);

        if (!response.ok) return null;

        const data = await response.json();
        if (!data.items || data.items.length === 0) return null;

        // Helper to normalize text
        const normalize = (t) => (t || '').toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
        const expectedTitleNorm = normalize(cleanTitle);
        const expectedAuthorNorm = normalize(author);
        const expectedAuthorWords = expectedAuthorNorm.split(' ').filter(w => w.length > 2);

        // Find first result with matching title+author and valid cover
        for (const item of data.items) {
            const volumeInfo = item.volumeInfo;
            if (!volumeInfo.imageLinks) continue;

            const resultTitleNorm = normalize(volumeInfo.title);

            // STRICT title check: require full containment
            const titleMatches = resultTitleNorm.includes(expectedTitleNorm) ||
                expectedTitleNorm.includes(resultTitleNorm) ||
                resultTitleNorm === expectedTitleNorm;

            if (!titleMatches) {
                console.log(`Skipping Google Books "${volumeInfo.title}" - title doesn't match "${cleanTitle}"`);
                continue;
            }

            // Author check
            const resultAuthors = volumeInfo.authors ? volumeInfo.authors.join(' ') : '';
            const resultAuthorNorm = normalize(resultAuthors);

            let authorMatches = false;
            if (!author || expectedAuthorWords.length === 0) {
                authorMatches = true;
            } else {
                for (const word of expectedAuthorWords) {
                    if (resultAuthorNorm.includes(word)) {
                        authorMatches = true;
                        break;
                    }
                }
            }

            if (!authorMatches) {
                console.log(`Skipping Google Books "${volumeInfo.title}" by ${resultAuthors} - author doesn't match "${author}"`);
                continue;
            }

            let url = volumeInfo.imageLinks.thumbnail || volumeInfo.imageLinks.smallThumbnail;
            if (url) {
                // Upgrade to https but keep the original zoom level
                // Requesting higher zoom (zoom=3) for books that only have low-res images
                // causes Google to return a placeholder instead
                url = url.replace('http://', 'https://');
                url = url.replace('&edge=curl', '');
                // Don't modify zoom - use whatever quality exists

                // Validate the image loads
                const isValid = await isValidGoogleImage(url);
                if (isValid) {
                    console.log(`Found cover via Google Books for "${title}" -> "${volumeInfo.title}" by ${resultAuthors}`);
                    return url;
                } else {
                    console.log(`Rejected Google Books cover for "${volumeInfo.title}" - failed to load`);
                }
            }
        }

        return null;
    } catch (e) {
        console.warn(`Failed to fetch cover from Google Books for "${title}":`, e);
        return null;
    }
}

// Validate a Google Books image loads correctly and is reasonably sized
async function isValidGoogleImage(url) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = function () {
            // Accept any image that's at least 40x40 pixels
            // The title+author matching provides the quality control
            if (this.naturalWidth >= 40 && this.naturalHeight >= 40) {
                resolve(true);
            } else {
                console.log(`Rejecting small Google image: ${this.naturalWidth}x${this.naturalHeight}`);
                resolve(false);
            }
        };
        img.onerror = function () {
            resolve(false);
        };
        img.src = url;
    });
}

// Combined cover fetcher: tries OpenLibrary first, then Google Books
async function fetchBookCover(title, author, isbn) {
    // Try OpenLibrary first (preferred)
    const openLibraryCover = await fetchCoverFromOpenLibrary(title, author, isbn);
    if (openLibraryCover) return openLibraryCover;

    // Fallback to Google Books
    console.log(`OpenLibrary failed for "${title}", trying Google Books...`);
    const googleCover = await fetchCoverFromGoogleBooks(title, author);
    if (googleCover) return googleCover;

    return null;
}

// Initialize books array
let books = loadStoredBooks();

// One-time migration: Reset for fixed zoom issue
// Version 9: Fixed zoom=3 causing placeholders for low-res Google Books images
const COVER_LOGIC_VERSION = 9; // Increment this to force a retry reset
if (readStoredValue('coverLogicVersion') !== String(COVER_LOGIC_VERSION)) {
    let resetCount = 0;
    books.forEach(book => {
        // Reset failed flags - covers that failed due to zoom issue can be retried
        if (book.cover_fetch_failed) {
            book.cover_fetch_failed = false;
            resetCount++;
        }
    });
    if (resetCount > 0) {
        console.log(`Migration v9: Reset ${resetCount} books to retry with fixed zoom setting`);
        writeStoredJSON('books', books);
    }
    writeStoredValue('coverLogicVersion', String(COVER_LOGIC_VERSION));
}

function saveBooks() {
    return writeStoredJSON('books', books);
}
