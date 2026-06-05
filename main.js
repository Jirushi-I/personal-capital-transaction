const {
    Plugin,
    PluginSettingTab,
    Setting,
    TextFileView,
    TFile,
    parseYaml
} = require("obsidian");

const VIEW_TYPE = "jsonl-finance";

const DEFAULT_SETTINGS = {
    ledgerFolder: "finance/Data",
    balanceSheetFolder: "Balance Sheets",
    balanceSheetSync: false,
    balanceSheetSyncDelayMs: 900,
    defaultCashAccount: "Cash:CAD"
};

module.exports = class PersonalCapitalTransactionPlugin extends Plugin {

    async onload() {

        await this.loadSettings();

        this.pendingSyncs = new Map();

        this.addSettingTab(new TransactionSettingTab(this.app, this));

        this.registerView(
            VIEW_TYPE,
            leaf => new JsonlLedgerView(leaf)
        );

        this.registerExtensions(
            ["jsonl"],
            VIEW_TYPE
        );

        this.registerEvent(
            this.app.vault.on("modify", file => {
                if (this.settings.balanceSheetSync) {
                    this.scheduleBalanceSheetSync(file);
                }
            })
        );

        this.addCommand({
            id: "sync-balance-sheets-to-ledger",
            name: "Sync balance sheets to ledger",
            callback: () => this.syncAllBalanceSheets()
        });
    }

    async loadSettings() {
        this.settings = Object.assign(
            {},
            DEFAULT_SETTINGS,
            await this.loadData()
        );
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    onunload() {
        for (const timer of this.pendingSyncs?.values?.() || []) {
            clearTimeout(timer);
        }
        this.pendingSyncs?.clear?.();
    }

    scheduleBalanceSheetSync(file) {

        if (!(file instanceof TFile))
            return;

        if (file.extension !== "md")
            return;

        const folder = (this.settings.balanceSheetFolder || "").replace(/\/+$/, "");

        if (!file.path.startsWith(folder + "/"))
            return;

        const existing = this.pendingSyncs.get(file.path);

        if (existing) {
            clearTimeout(existing);
        }

        const timer = setTimeout(() => {
            this.pendingSyncs.delete(file.path);
            this.syncBalanceSheetToLedger(file).catch(err => {
                console.error("[personal-capital-transaction] balance sheet sync failed", err);
            });
        }, Number(this.settings.balanceSheetSyncDelayMs) || DEFAULT_SETTINGS.balanceSheetSyncDelayMs);

        this.pendingSyncs.set(file.path, timer);
    }

    async syncBalanceSheetToLedger(file) {

        const content = await this.app.vault.read(file);
        const frontmatter = this.readFrontmatter(content);

        if (!frontmatter?.drawer_counter)
            return;

        const date = this.getDateFromFile(file);
        const layout = this.getLayout(frontmatter.drawer_counter);
        const index = this.getBlockIndex(layout);
        const entries = this.getBalanceSheetEntries(file, date, layout, index);

        await this.upsertLedgerEntries(date, entries, file.path);
    }

    async syncAllBalanceSheets() {
        const folder = (this.settings.balanceSheetFolder || "").replace(/\/+$/, "");
        const files = this.app.vault.getMarkdownFiles()
            .filter(file => file.path.startsWith(folder + "/"));

        for (const file of files) {
            await this.syncBalanceSheetToLedger(file);
        }
    }

    readFrontmatter(content) {

        const match = content.match(/^---\n([\s\S]*?)\n---/);

        if (!match)
            return null;

        try {
            return parseYaml(match[1]);
        } catch (err) {
            console.error("[personal-capital-transaction] invalid frontmatter", err);
            return null;
        }
    }

    getDateFromFile(file) {
        const match = file.basename.match(/\d{4}-\d{2}-\d{2}/);

        if (match)
            return match[0];

        return new Date().toISOString().slice(0, 10);
    }

    getLayout(drawerCounter) {

        if (Array.isArray(drawerCounter))
            return drawerCounter;

        const data = drawerCounter || {};
        const layout = [
            {
                type: "template_bns",
                name: "Banknotes",
                qtys: Array.isArray(data.bns) ? data.bns : [0, 0, 0, 0, 0]
            },
            {
                type: "template_rolls",
                name: "Rolls",
                qtys: Array.isArray(data.rolls) ? data.rolls : [0, 0, 0, 0, 0]
            }
        ];

        if (Array.isArray(data.additional)) {
            layout.push({
                type: "accounts_insert",
                name: "Additional",
                folder: "Income/",
                rows: data.additional
            });
        }

        if (Array.isArray(data.expenses)) {
            layout.push({
                type: "accounts_insert",
                name: "Expenses",
                folder: "Expenses/",
                rows: data.expenses
            });
        }

        return layout;
    }

    getBlockIndex(layout) {
        const index = {};

        layout.forEach(block => {
            if (block?.name) {
                index[block.name] = block;
            }
        });

        return index;
    }

    getBalanceSheetEntries(file, date, layout, index) {

        const entries = [];

        layout.forEach(block => {
            if (block.type === "account_sync") {
                const amount = this.calculateIncludesTotal(block.includes, index);

                if (amount > 0) {
                    entries.push(this.makeLedgerEntry({
                        file,
                        date,
                        type: this.typeFromFolder(block.folder, "income"),
                        amount,
                        name: block.account,
                        note: block.name || "",
                        sourceBlock: block.name || "account_sync"
                    }));
                }
            }

            if (block.type === "accounts_insert") {
                const type = this.typeFromFolder(block.folder, "income");

                (block.rows || []).forEach((row, i) => {
                    const amount = Number(row?.amount) || 0;
                    const name = String(row?.account || "").trim();

                    if (!name || amount === 0)
                        return;

                    entries.push(this.makeLedgerEntry({
                        file,
                        date,
                        type,
                        amount,
                        name,
                        note: row?.desc || "",
                        sourceBlock: block.name || "accounts_insert",
                        sourceIndex: i
                    }));
                });
            }
        });

        return entries;
    }

    makeLedgerEntry({ file, date, type, amount, name, note, sourceBlock, sourceIndex }) {

        const key = [
            file.path,
            date,
            type,
            sourceBlock || "",
            sourceIndex ?? "",
            name
        ].join("|");

        const account =
            this.resolveLedgerAccount(
                type,
                name,
                note
            );

        const entry = {
            d: date,
            type,
            amt: Number(amount),
            cat: name,
            source: "finance-balance-sheet",
            sourceFile: file.path,
            sourceBlock,
            sourceName: name,
            id: this.stableId(key)
        };

        if (type === "income") {
            entry.to = account;
        } else {
            entry.from = account;
        }

        if (note) {
            entry.note = String(note);
        }

        return entry;
    }

    stableId(value) {
        let hash = 2166136261;

        for (let i = 0; i < value.length; i++) {
            hash ^= value.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }

        return `fbs_${(hash >>> 0).toString(16)}`;
    }

    typeFromFolder(folder, fallback) {
        const text = String(folder || "").toLowerCase();

        if (text.includes("expense"))
            return "expense";

        if (text.includes("income"))
            return "income";

        return fallback;
    }

    calculateIncludesTotal(includes, index) {
        return (includes || []).reduce((sum, name) => {
            return sum + this.calculateBlockTotal(index[name], index);
        }, 0);
    }

    calculateBlockTotal(block, index = {}) {

        if (!block)
            return 0;

        if (block.type === "template_bns") {
            return [5, 10, 20, 50, 100].reduce((sum, value, i) => {
                return sum + ((Number(block.qtys?.[i]) || 0) * value);
            }, 0);
        }

        if (block.type === "template_rolls") {
            return [2, 5, 10, 25, 50].reduce((sum, value, i) => {
                return sum + ((Number(block.qtys?.[i]) || 0) * value);
            }, 0);
        }

        if (block.type === "accounts_insert") {
            return (block.rows || []).reduce((sum, row) => {
                return sum + (Number(row?.amount) || 0);
            }, 0);
        }

        if (block.type === "total") {
            return this.calculateIncludesTotal(block.includes, index);
        }

        return 0;
    }

    async upsertLedgerEntries(date, entries, sourceFile) {

        const year = date.slice(0, 4);
        const path = `${(this.settings.ledgerFolder || DEFAULT_SETTINGS.ledgerFolder).replace(/\/+$/, "")}/ledger-${year}.jsonl`;
        const file = this.app.vault.getAbstractFileByPath(path);

        if (!entries.length && !(file instanceof TFile))
            return;

        const existingContent = file instanceof TFile ? await this.app.vault.read(file) : "";
        const existingEntries = this.parseLedger(existingContent);
        const incomingKeys = new Set(entries.map(entry => this.entryKey(entry)));
        const output = [];
        const replaced = new Set();

        existingEntries.forEach(entry => {
            const key = this.entryKey(entry);
            const replacement = entries.find(incoming => this.entryMatches(entry, incoming));

            if (replacement && !replaced.has(key)) {
                output.push(replacement);
                replaced.add(key);
                return;
            }

            if (
                entry.source === "finance-balance-sheet" &&
                entry.sourceFile === sourceFile &&
                !incomingKeys.has(key)
            ) {
                return;
            }

            output.push(entry);
        });

        entries.forEach(entry => {
            if (!output.some(existing => this.entryMatches(existing, entry))) {
                output.push(entry);
            }
        });

        output.sort((a, b) => this.compareEntries(a, b));

        const nextContent = output.map(entry => JSON.stringify(entry)).join("\n") + "\n";

        if (file instanceof TFile) {
            if (existingContent !== nextContent) {
                await this.app.vault.modify(file, nextContent);
            }
            return;
        }

        await this.ensureFolder(path);
        await this.app.vault.create(path, nextContent);
    }

    entryKey(entry) {
        return [
            entry.d || "",
            entry.type || "",
            entry.cat || entry.sourceName || "",
            entry.sourceFile || "",
            entry.sourceBlock || "",
            entry.sourceIndex ?? ""
        ].join("|");
    }

    entryMatches(existing, incoming) {

        if (existing.id && incoming.id && existing.id === incoming.id)
            return true;

        if (
            existing.source === "finance-balance-sheet" &&
            incoming.source === "finance-balance-sheet" &&
            existing.sourceFile === incoming.sourceFile &&
            existing.sourceBlock === incoming.sourceBlock &&
            existing.sourceIndex === incoming.sourceIndex
        ) {
            return true;
        }

        return (
            existing.d === incoming.d &&
            existing.type === incoming.type &&
            String(existing.cat || existing.sourceName || "") === String(incoming.cat || incoming.sourceName || "")
        );
    }

    compareEntries(a, b) {
        const typeOrder = { income: 0, expense: 1, transfer: 2 };

        return (
            String(a.d || "").localeCompare(String(b.d || "")) ||
            ((typeOrder[a.type] ?? 9) - (typeOrder[b.type] ?? 9)) ||
            String(a.cat || "").localeCompare(String(b.cat || "")) ||
            String(a.note || "").localeCompare(String(b.note || ""))
        );
    }

    parseLedger(text) {
        return text
            .split("\n")
            .map(line => line.trim())
            .filter(Boolean)
            .map(line => {
                try {
                    return JSON.parse(line);
                } catch {
                    return null;
                }
            })
            .filter(Boolean);
    }

    async ensureFolder(path) {
        const folder = path.split("/").slice(0, -1).join("/");

        if (folder && !this.app.vault.getAbstractFileByPath(folder)) {
            await this.app.vault.createFolder(folder).catch(() => {});
        }
    }



    inferCurrencyAccount(text) {

        const value = String(text || "").toUpperCase();

        const currencies = [
            "CAD",
            "USD",
            "EUR",
            "GBP",
            "JPY",
            "AUD",
            "CHF",
            "CNY",
            "INR"
        ];

        for (const currency of currencies) {

            const regex = new RegExp(`\\b${currency}\\b`);

            if (regex.test(value)) {
                return `Cash:${currency}`;
            }
        }

        return this.settings.defaultCashAccount || "Cash:CAD";
    }

    resolveLedgerAccount(type, name, note) {

        return this.inferCurrencyAccount(
            `${name || ""} ${note || ""}`
        );
    }
};

class JsonlLedgerView extends TextFileView {

    rawText = "";
    entries = [];

    getViewType() {
        return VIEW_TYPE;
    }

    getDisplayText() {
        return this.file?.name || "Ledger";
    }

    async setViewData(text) {

        this.rawText = text;
        this.entries = this.parseRows(text);

        this.render();
    }

    render() {

        this.contentEl.empty();
        this.contentEl.addClass("pct-root");

        const entries = [...this.entries].sort((a, b) => this.compareEntries(a, b));
        const totals = this.getTotals(entries);

        const header = this.contentEl.createDiv("pct-header");
        const title = header.createDiv("pct-title");
        title.setText(this.file?.name || "Transactions");

        const summary = header.createDiv("pct-summary");
        summary.createSpan({ text: `${entries.length} entries` });
        summary.createSpan({ text: `Income ${this.money(totals.income)}` });
        summary.createSpan({ text: `Expenses ${this.money(totals.expense)}` });
        summary.createSpan({ text: `Net ${this.money(totals.income - totals.expense)}` });

        const table = this.contentEl.createEl("table", {
            cls: "pct-table"
        });

        const head = table.createEl("thead").createEl("tr");

        ["Date", "Type", "Name", "Account", "Note", "Amount", ""].forEach(label => {
            head.createEl("th", { text: label });
        });

        const body = table.createEl("tbody");

        entries.forEach(entry => {
                const row = body.createEl("tr");
                row.addClass(`pct-row-${entry.type || "other"}`);

                this.createInputCell(row, entry.d || "", "pct-date", async value => {
                    entry.d = value.trim();
                    await this.saveEntries();
                });

                this.createSelectCell(row, entry.type || "expense", "pct-type", ["income", "expense", "transfer"], async value => {
                    entry.type = value;
                    this.normalizeAccountField(entry);
                    await this.saveEntries();
                    this.render();
                });

                this.createInputCell(row, entry.cat || entry.asset || "", "pct-name", async value => {
                    entry.cat = value.trim();
                    await this.saveEntries();
                });

                this.createInputCell(row, this.getAccount(entry), "pct-account", async value => {
                    this.setAccount(entry, value.trim());
                    await this.saveEntries();
                });

                this.createInputCell(row, entry.note || "", "pct-note", async value => {
                    const note = value.trim();

                    if (note) {
                        entry.note = note;
                    } else {
                        delete entry.note;
                    }

                    await this.saveEntries();
                });

                this.createInputCell(row, String(entry.amt ?? 0), "pct-amount", async value => {
                    entry.amt = Number(String(value).replace("$", "")) || 0;
                    await this.saveEntries();
                    this.render();
                });

                const removeCell = row.createEl("td", {
                    cls: "pct-actions"
                });
                const removeBtn = removeCell.createEl("button", {
                    text: "Remove",
                    cls: "pct-row-btn"
                });

                removeBtn.addEventListener("click", async () => {
                    this.entries = this.entries.filter(item => item !== entry);
                    await this.saveEntries();
                    this.render();
                });
            });

        const addRow = body.createEl("tr");
        const addCell = addRow.createEl("td", {
            cls: "pct-add-row"
        });
        addCell.setAttr("colspan", "7");
        const addBtn = addCell.createEl("button", {
            text: "Add Row",
            cls: "pct-add-btn"
        });

        addBtn.addEventListener("click", async () => {
            this.entries.push({
                d: this.today(),
                type: "expense",
                amt: 0,
                cat: "",
                from: ""
            });
            await this.saveEntries();
            this.render();
        });
    }

    createInputCell(row, value, cls, onSave) {

        const cell = row.createEl("td", {
            cls
        });
        const input = cell.createEl("input", {
            type: "text",
            cls: "pct-input"
        });

        input.value = value;

        input.addEventListener("blur", () => onSave(input.value));
        input.addEventListener("keydown", event => {
            if (event.key === "Enter") {
                input.blur();
            }
        });
    }

    createSelectCell(row, value, cls, options, onSave) {

        const cell = row.createEl("td", {
            cls
        });
        const select = cell.createEl("select", {
            cls: "pct-input"
        });

        options.forEach(option => {
            select.createEl("option", {
                text: option,
                value: option
            });
        });

        select.value = value;
        select.addEventListener("change", () => onSave(select.value));
    }

    async saveEntries() {
        this.rawText = this.serializeRows(this.entries);

        if (this.file) {
            await this.app.vault.modify(this.file, this.rawText);
        }
    }

    serializeRows(entries) {
        return [...entries]
            .sort((a, b) => this.compareEntries(a, b))
            .map(entry => JSON.stringify(this.cleanEntry(entry)))
            .join("\n") + "\n";
    }

    cleanEntry(entry) {
        const cleaned = {};

        Object.entries(entry).forEach(([key, value]) => {
            if (value === undefined || value === null || value === "")
                return;

            cleaned[key] = value;
        });

        return cleaned;
    }

    getAccount(entry) {
        return entry.to || entry.from || "";
    }

    setAccount(entry, account) {
        if (entry.type === "income") {
            entry.to = account;
            delete entry.from;
        } else {
            entry.from = account;
            delete entry.to;
        }
    }

    normalizeAccountField(entry) {
        const account = this.getAccount(entry);
        this.setAccount(entry, account);
    }

    today() {
        return new Date().toISOString().slice(0, 10);
    }

    parseRows(text) {
        return text
            .split("\n")
            .map(line => line.trim())
            .filter(Boolean)
            .map(line => {
                try {
                    return JSON.parse(line);
                } catch {
                    return null;
                }
            })
            .filter(Boolean);
    }

    getTotals(entries) {
        return entries.reduce((totals, entry) => {
            const amount = Number(entry.amt) || 0;

            if (entry.type === "income") {
                totals.income += amount;
            } else if (entry.type === "expense") {
                totals.expense += amount;
            }

            return totals;
        }, {
            income: 0,
            expense: 0
        });
    }

    compareEntries(a, b) {
        const typeOrder = { income: 0, expense: 1, transfer: 2 };

        return (
            String(a.d || "").localeCompare(String(b.d || "")) ||
            ((typeOrder[a.type] ?? 9) - (typeOrder[b.type] ?? 9)) ||
            String(a.cat || "").localeCompare(String(b.cat || ""))
        );
    }

    money(value) {
        return `${(Number(value) || 0).toFixed(2)}$`;
    }

    getViewData(){
        return this.rawText;
    }

    clear(){
        this.rawText = "";
        this.contentEl.empty();
    }
}

class TransactionSettingTab extends PluginSettingTab {

    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {

        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl)
            .setName("Ledger folder")
            .setDesc("Folder containing ledger-YYYY.jsonl files")
            .addText(text =>
                text
                    .setValue(this.plugin.settings.ledgerFolder)
                    .onChange(async value => {
                        this.plugin.settings.ledgerFolder = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Balance sheet folder")
            .setDesc("Folder watched by the optional balance sheet sync")
            .addText(text =>
                text
                    .setValue(this.plugin.settings.balanceSheetFolder)
                    .onChange(async value => {
                        this.plugin.settings.balanceSheetFolder = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Sync balance sheets to ledger")
            .setDesc("Debounced middleware: upsert generated balance sheet entries into ledger-YYYY.jsonl")
            .addToggle(toggle =>
                toggle
                    .setValue(this.plugin.settings.balanceSheetSync)
                    .onChange(async value => {
                        this.plugin.settings.balanceSheetSync = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Default cash account")
            .setDesc("Fallback account for generated balance-sheet entries")
            .addText(text =>
                text
                    .setValue(this.plugin.settings.defaultCashAccount)
                    .onChange(async value => {

                        this.plugin.settings.defaultCashAccount = value;

                        await this.plugin.saveSettings();
                    })
            );
    }
}
