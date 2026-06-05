# This is a light Obsidian plugin I made for a volunteering project. It has a niche scope.


## Personal Capital Transactions

For Obsidian, complements the Personal Capital plugin by adding JSONL file rendering to view and edit ledgers
Also has optional ledger syncing for my other plugin, Finance Balance Sheet.

### Features

- Reads transaction lines from `data.json` or JSONL-formatted finance transaction files
- Renders transactions in a user-friendly table inside Obsidian
- Can work alongside the Finance Balance Sheet plugin to bridge the gap between printable and data-friendly accounting
- Will store cash register/petty income/etc. as its own account

### Installation

1. Place the plugin folder into `.obsidian/plugins/personal-capital-transaction`
2. Enable the plugin from Obsidian Settings → Community plugins
3. Use the plugin with the transaction data file

### Usage

- Open any JSONL file (should be ledger-YYYY.jsonl for Personal Capital)
- The plugin will display transaction data without requiring external software
- You can change values or press Remove to remove lines 
- If enabled, accounts from Balance Sheets will be imported in the ledger of the corresponding year.
