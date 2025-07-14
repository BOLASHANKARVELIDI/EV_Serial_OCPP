document.addEventListener("DOMContentLoaded", function() {
    // ==================== CONFIGURATION ====================
    const config = {
        bufferSize: 1000000,
        scrollThreshold: 100,
        reconnectDelay: 100,
        defaultBaudRate: 115200
    };

    // ==================== STATE MANAGEMENT ====================
    const state = {
        port: null,
        reader: null,
        keepReading: false,
        paused: false,
        autoScroll: true,
        rawDataBuffer: "",
        transactions: {},
        jsonViewExpanded: true,     
        jsonPacketHistory: [],      
        lastStatusNotification: null,
        separatorPaused: false, 
        requestResponseMap: {}
    };

    // ==================== DOM ELEMENTS ====================
    const elements = {
        serialData: document.getElementById("serial-data"),
        jsonData: document.getElementById("json-data"),
        pauseSeparatorBtn: document.getElementById("pause-separator-btn"), 
        continueSeparatorBtn: document.getElementById("continue-separator-btn"),
        clearSeparatorBtn: document.getElementById("clear-separator-btn"), 
        saveSeparatorBtn: document.getElementById("save-separator-btn"),
        toggleJsonViewBtn: document.getElementById('toggle-json-view'),             
        jsonPacketSpacingInput: document.getElementById('json-packet-spacing'), 
        transactionBody: document.getElementById("transaction-body"),
        connectionStatus: document.getElementById("connection-status"),
        connectBtn: document.getElementById("connect-btn"),
        disconnectBtn: document.getElementById("disconnect-btn"),
        pauseBtn: document.getElementById("pause-btn"),
        continueBtn: document.getElementById("continue-btn"),
        clearBtn: document.getElementById("clear-btn"),
        saveBtn: document.getElementById("save-btn"),
        baudRateSelect: document.getElementById("baud-rate"),
        customBaudInput: document.getElementById("custom-baud"),
        searchInput: document.getElementById("search-input"), 
        searchBtn: document.getElementById("search-btn"),
        clearSearchBtn: document.getElementById("clear-search-btn"), 
        searchTransaction: document.getElementById("search-transaction"),
        refreshBtn: document.getElementById("refresh-btn"),
        exportCsvBtn: document.getElementById("export-csv-btn")
    };

    // ==================== SERIAL COMMUNICATION ====================
    async function connectSerial() {
        try {
            if (!navigator.serial) {
                throw new Error("Web Serial API not supported in your browser");
            }
            state.port = await navigator.serial.requestPort();
            if (!state.port) {
                return; // User cancelled port selection
            }
            const baudRate = getBaudRate();
            await state.port.open({ baudRate, bufferSize: config.bufferSize });
            state.keepReading = true;
            updateConnectionStatus(true);
            setButtonStates(true);
            readSerialData();
        } catch (error) {
            console.error("Connection error:", error);
            showError(`Connection failed: ${error.message}`);
            await disconnectSerial();
        }
    }

    async function disconnectSerial() {
        state.keepReading = false;
        try {
            if (state.reader) {
                await state.reader.cancel();
                state.reader.releaseLock();
                state.reader = null;
            }
            if (state.port) {
                await state.port.close();
                state.port = null;
            }
        } catch (error) {
            console.error("Disconnect error:", error);
        } finally {
            updateConnectionStatus(false);
            setButtonStates(false);
            appendToSerialData("\n[Disconnected]\n");
        }
    }

    async function readSerialData() {
        const textDecoder = new TextDecoder();
        try {
            state.reader = state.port.readable.getReader();
            while (state.keepReading) {
                try {
                    const { value, done } = await state.reader.read();
                    if (done || !state.keepReading) break;
                    if (value && !state.paused) {
                        const text = textDecoder.decode(value, { stream: true });
                        state.rawDataBuffer += text;
                        appendToSerialData(text);
                        processNewData();
                    }
                } catch (readError) {
                    console.error("Read error:", readError);
                    appendToSerialData(`\n[Read Error: ${readError.message}]\n`, "error");
                    if (isConnectionError(readError)) {
                        await attemptReconnect();
                    }
                }
            }
        } catch (error) {
            console.error("Read loop error:", error);
            appendToSerialData(`\n[Fatal Error: ${error.message}]\n`, "error");
        } finally {
            if (state.reader) {
                state.reader.releaseLock();
                state.reader = null;
            }
        }
    }

    // ==================== DATA PROCESSING ====================
    function processNewData() {
        if (state.separatorPaused) return; 
        const jsonPackets = extractJsonPackets(state.rawDataBuffer);

        if (jsonPackets.length > 0) {
            jsonPackets.forEach(packet => {
                try {
                    const json = JSON.parse(packet);
                    if (Array.isArray(json) && (json[0] === 2 || json[0] === 3)) {
                        state.jsonPacketHistory.push({ raw: packet, parsed: json }); // MODIFIED
                        displayJsonPacket(packet, json);
                        processOcppPacket(json);
                    }
                } catch (e) {
                    // Ignore parsing errors for incomplete packets, they'll be processed next time
                }
            });

            const lastPacket = jsonPackets[jsonPackets.length - 1];
            const processedLength = state.rawDataBuffer.lastIndexOf(lastPacket) + lastPacket.length;
            state.rawDataBuffer = state.rawDataBuffer.slice(processedLength);
        }
    }

    function extractJsonPackets(str) {
        const packets = [];
        let searchIndex = 0;
        while (searchIndex < str.length) {
            const startIndex = str.indexOf('[', searchIndex);
            if (startIndex === -1) break;

            let braceCount = 0;
            let bracketCount = 1;
            let inString = false;
            let i = startIndex + 1;

            while (i < str.length && bracketCount > 0) {
                const char = str[i];
                if (char === '"' && str[i - 1] !== '\\') {
                    inString = !inString;
                } else if (!inString) {
                    if (char === '[') bracketCount++;
                    else if (char === ']') bracketCount--;
                    else if (char === '{') braceCount++;
                    else if (char === '}') braceCount--;
                }
                i++;
            }

            if (bracketCount === 0) {
                const packet = str.substring(startIndex, i);
                packets.push(packet);
                searchIndex = i;
            } else {
                searchIndex = startIndex + 1; // Incomplete packet, search from next char
            }
        }
        return packets;
    }


    // ==================== OCPP PROCESSING ====================
    function processOcppPacket(packet) {
        if (!Array.isArray(packet) || (packet[0] !== 2 && packet[0] !== 3)) return;

        const messageType = packet[0];
        const messageId = packet[1] || "unknown";
        try {
            if (messageType === 2) { // Request
                const action = packet[2];
                const payload = packet[3] || {};
                state.requestResponseMap[messageId] = packet;

                switch (action) {
                    case "StopTransaction":
                        handleStopTransaction(payload);
                        break;
                    case "MeterValues":
                        handleMeterValues(payload);
                        break;
                    case "StatusNotification":
                        appendToSerialData(`\n[Status: ${payload.status} on connector ${payload.connectorId}]\n`, "info");
                        break;
                }
            } else if (messageType === 3) { // Response
                const responsePayload = packet[2] || {};
                const requestPacket = state.requestResponseMap[messageId];
                if (requestPacket) {
                    const requestAction = requestPacket[2];
                    if (requestAction === "StartTransaction") {
                        handleStartTransactionResponse(requestPacket, responsePayload);
                    }
                    // No need for handleStopTransactionResponse if the request already finalizes it
                }
            }
        } catch (error) {
            console.error("OCPP Processing Error:", error, packet);
            appendToSerialData(`\n[OCPP Error: ${error.message}]\n`, "error");
        }
    }

    // ==================== TRANSACTION HANDLERS ====================
    function handleStartTransactionResponse(requestPacket, responsePayload) {
        const transactionId = responsePayload.transactionId;
        if (!transactionId || responsePayload.idTagInfo?.status !== 'Accepted') return;

        if (!state.transactions[transactionId]) {
            const payload = requestPacket[3] || {};
            state.transactions[transactionId] = {
                connectorId: payload.connectorId || 1,
                idTag: payload.idTag || "-",
                startTime: new Date(payload.timestamp).toLocaleString(),
                meterStart: payload.meterStart || 0,
                status: "Active",
                stopTime: "-",
                meterStop: 0,
                energyWh: 0,
                reason: "-"
            };
            updateTransactionTable();
        }
    }

    // function handleStopTransaction(payload = {}) {
    //     const transactionId = payload.transactionId;
    //     if (!transactionId || !state.transactions[transactionId]) return;

    //     const tx = state.transactions[transactionId];
    //     state.transactions[transactionId] = {
    //         ...tx,
    //         stopTime: payload.timestamp ? new Date(payload.timestamp).toLocaleString() : new Date().toLocaleString(),
    //         meterStop: payload.meterStop || tx.meterStop || tx.meterStart,
    //         status: "Completed",
    //         reason: payload.reason || tx.reason || "Remote",
    //     };
        
    //     const finalTx = state.transactions[transactionId];
    //     finalTx.energyWh = Math.max(0, (finalTx.meterStop - finalTx.meterStart));
        
    //     updateTransactionTable();
    // }

    // REPLACE the old handleStopTransaction function with this one
    function handleStopTransaction(payload = {}) {
        const transactionId = payload.transactionId;
        if (!transactionId || !state.transactions[transactionId]) return;

        const tx = state.transactions[transactionId];
        let reason = payload.reason || tx.reason || "Remote";

        // If reason is generic, try to get a more specific one from a recent StatusNotification
        if (state.lastStatusNotification) {
            const stopTime = payload.timestamp ? new Date(payload.timestamp).getTime() : Date.now();
            // Check if the status notification was within the last 5 seconds
            if (Math.abs(stopTime - state.lastStatusNotification.timestamp) < 5000) {
                const statusPayload = state.lastStatusNotification.payload;
                if (reason === 'Remote') {
                    // For "Remote", prefer vendor-specific error codes
                    reason = statusPayload.vendorErrorCode || statusPayload.errorCode || reason;
                } else if (reason === 'Other') {
                    // For "Other", concatenate the status
                    reason = `Other - ${statusPayload.status}`;
                }
            }
        }

        state.transactions[transactionId] = {
            ...tx,
            stopTime: payload.timestamp ? new Date(payload.timestamp).toLocaleString() : new Date().toLocaleString(),
            meterStop: payload.meterStop || tx.meterStop || tx.meterStart,
            status: "Completed",
            reason: reason,
        };

        const finalTx = state.transactions[transactionId];
        finalTx.energyWh = Math.max(0, (finalTx.meterStop - finalTx.meterStart));

        updateTransactionTable();
    }

    function handleMeterValues(payload = {}) {
        const transactionId = payload.transactionId;
        if (!transactionId || !state.transactions[transactionId]) return;

        const tx = state.transactions[transactionId];
        if (tx.status !== 'Active') return; // Don't update completed transactions with meter values

        const meterValueSample = payload.meterValue?.[0]?.sampledValue?.find(
            sv => sv.measurand === "Energy.Active.Import.Register"
        );
        const meterValue = meterValueSample ? parseInt(meterValueSample.value) : null;

        if (meterValue !== null) {
            state.transactions[transactionId] = {
                ...tx,
                meterStop: meterValue, // meterStop is the "last known meter value" during transaction
                energyWh: Math.max(0, meterValue - tx.meterStart)
            };
            updateTransactionTable();
        }
    }

    // ==================== UI FUNCTIONS ====================
    function displayJsonPacket(rawJson, parsedJson) {
        if (!elements.jsonData) return;

        // Check if user is scrolled to the bottom BEFORE adding new content
        const scrollThreshold = 100; // Pixels from bottom
        const isScrolledToBottom = elements.jsonData.scrollHeight - elements.jsonData.scrollTop <= elements.jsonData.clientHeight + scrollThreshold;

        const timestamp = new Date().toLocaleTimeString();
        let messageType, action;

        try {
            messageType = parsedJson[0] === 2 ? "Request" : "Response";
            if (messageType === 'Response') {
                const requestPacket = state.requestResponseMap[parsedJson[1]];
                action = requestPacket ? `${requestPacket[2]}.conf` : "Response";
            } else {
                action = parsedJson[2] || "Unknown";
            }
        } catch (e) {
            console.warn("Invalid OCPP packet structure:", parsedJson, e);
            return;
        }

        const packetEl = document.createElement("div");
        packetEl.className = "json-packet";
        packetEl.innerHTML = `
            <div class="json-header">
                <span class="json-timestamp">[${timestamp}]</span>
                <span class="message-type ${messageType.toLowerCase()}">${messageType}</span>
                <strong>${action}</strong>
            </div>
            ${syntaxHighlightJSON(rawJson, state.jsonViewExpanded)}
        `;

        elements.jsonData.appendChild(packetEl);
        if (isScrolledToBottom) { // Assuming auto-scroll for JSON view as well
             elements.jsonData.scrollTop = elements.jsonData.scrollHeight;
        }
    }

    function updateTransactionTable() {
        if (!elements.transactionBody) return;

        try {
            elements.transactionBody.innerHTML = '';
            const searchTerm = elements.searchTransaction.value.toLowerCase();
            const sortedTransactions = Object.entries(state.transactions)
                .sort((a, b) => new Date(b[1].startTime) - new Date(a[1].startTime));

            sortedTransactions.forEach(([id, tx]) => {
                const transactionString = JSON.stringify(tx).toLowerCase();
                if (searchTerm && !id.toLowerCase().includes(searchTerm) && !transactionString.includes(searchTerm)) return;

                const row = document.createElement("tr");
                row.innerHTML = `
                    <td>${id}</td>
                    <td>${tx.connectorId || 1}</td>
                    <td>${tx.idTag || "-"}</td>
                    <td>${tx.startTime || "-"}</td>
                    <td>${tx.stopTime || "-"}</td>
                    <td>${tx.meterStart || 0}</td>
                    <td>${tx.meterStop || 0}</td>
                    <td>${tx.energyWh || 0}</td>
                    <td class="status-${tx.status?.toLowerCase() || 'unknown'}">${tx.status || "Unknown"}</td>
                    <td>${tx.reason || "-"}</td>
                `;
                elements.transactionBody.appendChild(row);
            });
        } catch (error) {
            console.error("Transaction table error:", error);
        }
    }

    function redrawJsonPackets() {
        elements.jsonData.innerHTML = '';
        state.jsonPacketHistory.forEach(packet => {
            displayJsonPacket(packet.raw, packet.parsed);
        });
    }

    // ==================== UTILITY FUNCTIONS ====================
    // REPLACE the old appendToSerialData function with this one
    function appendToSerialData(text, className = "") {
        if (!elements.serialData) return;

        // If there's a class, we need a wrapper span
        if (className) {
            const span = document.createElement("span");
            span.className = className;
            span.textContent = text;
            elements.serialData.appendChild(span);
        } else {
            // Otherwise, append a raw text node to preserve formatting
            const textNode = document.createTextNode(text);
            elements.serialData.appendChild(textNode);
        }

        if (state.autoScroll) {
            elements.serialData.scrollTop = elements.serialData.scrollHeight;
        }
    }

    // REPLACE the old syntaxHighlightJSON function with this one
    function syntaxHighlightJSON(jsonString, isExpanded = true) {
        if (!jsonString) return '<pre></pre>';

        const valueClassMap = {
            'Accepted': 'json-value-accepted', 'Rejected': 'json-value-rejected',
            'Faulted': 'json-value-faulted', 'Available': 'json-value-available',
            'Charging': 'json-value-charging'
        };

        try {
            if (!isExpanded) {
                // Single-line view: Rebuild with proper HTML handling
                const json = JSON.parse(jsonString);
                
                // This function will be used by JSON.stringify to build the HTML string
                const replacer = (key, value) => {
                    let valueStr = JSON.stringify(value); // Default string representation

                    if (typeof value === 'string') {
                        const customClass = valueClassMap[value] || 'json-string';
                        // We wrap the JSON string representation (which includes quotes) in our span
                        valueStr = `<span class="${customClass}">${valueStr}</span>`;
                    } else if (typeof value === 'number') {
                        valueStr = `<span class="json-number">${value}</span>`;
                    } else if (typeof value === 'boolean') {
                        valueStr = `<span class="json-boolean">${value}</span>`;
                    } else if (value === null) {
                        valueStr = `<span class="json-null">null</span>`;
                    }

                    // If it's part of an object, add the key
                    if (key && !Array.isArray(this)) {
                        return `<span class="json-key">"${key}"</span>:${valueStr}`;
                    }
                    
                    return valueStr;
                };
                
                // We use a custom stringify function. We can't use JSON.stringify directly because it escapes our HTML.
                function customStringify(obj) {
                    if (Array.isArray(obj)) {
                        return `[${obj.map(item => customStringify(item)).join(',')}]`;
                    }
                    if (typeof obj === 'object' && obj !== null) {
                        const content = Object.keys(obj).map(key => {
                            // 'this' context for replacer
                            const context = {}; 
                            context[key] = obj[key];
                            return replacer.call(context, key, obj[key]);
                        }).join(',');
                        return `{${content}}`;
                    }
                    // For primitives, just use the replacer
                    return replacer.call({}, '', obj);
                }
                
                const htmlString = customStringify(json);
                return `<pre>${htmlString}</pre>`;
            }

            // Expanded view (This logic is correct and remains the same)
            const json = JSON.parse(jsonString);
            function buildHtml(data, indentLevel = 1) {
                const indent = '  '.repeat(indentLevel);
                const indentClose = '  '.repeat(indentLevel - 1);
                if (data === null) return `<span class="json-null">null</span>`;
                if (typeof data === 'string') {
                    const customClass = valueClassMap[data] || 'json-string';
                    return `<span class="${customClass}">"${data}"</span>`;
                }
                if (typeof data === 'number') return `<span class="json-number">${data}</span>`;
                if (typeof data === 'boolean') return `<span class="json-boolean">${data}</span>`;
                if (Array.isArray(data)) {
                    if (data.length === 0) return '[]';
                    let html = '[\n';
                    data.forEach((item, index) => {
                        html += `${indent}${buildHtml(item, indentLevel + 1)}`;
                        if (index < data.length - 1) html += ',';
                        html += '\n';
                    });
                    html += `${indentClose}]`;
                    return html;
                }
                if (typeof data === 'object') {
                    const keys = Object.keys(data);
                    if (keys.length === 0) return '{}';
                    let html = '{\n';
                    keys.forEach((key, index) => {
                        html += `${indent}<span class="json-key">"${key}"</span>: ${buildHtml(data[key], indentLevel + 1)}`;
                        if (index < keys.length - 1) html += ',';
                        html += '\n';
                    });
                    html += `${indentClose}}`;
                    return html;
                }
                return String(data);
            }
            return `<pre>${buildHtml(json)}</pre>`;
        } catch (e) {
            console.error("Syntax highlight error:", e);
            return `<pre class="error">${jsonString.replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>')}</pre>`;
        }
    }
    
    function getBaudRate() {
        return elements.baudRateSelect.value === "custom" ?
            parseInt(elements.customBaudInput.value) || config.defaultBaudRate :
            parseInt(elements.baudRateSelect.value) || config.defaultBaudRate;
    }

    function updateConnectionStatus(connected) {
        if (!elements.connectionStatus) return;
        elements.connectionStatus.textContent = connected ? "🟢 Connected" : "🔴 Disconnected";
        elements.connectionStatus.className = connected ? "status-connected" : "status-disconnected";
    }

    function isConnectionError(error) {
        const msg = error.message.toLowerCase();
        return msg.includes("disconnected") || msg.includes("closed") || msg.includes("failed");
    }

    async function attemptReconnect() {
        appendToSerialData("\n[Connection lost. Attempting to reconnect...]\n", "warning");
        await disconnectSerial();
        await new Promise(resolve => setTimeout(resolve, config.reconnectDelay));
        await connectSerial();
    }

    function setButtonStates(connected) {
        if (elements.connectBtn) elements.connectBtn.disabled = connected;
        if (elements.disconnectBtn) elements.disconnectBtn.disabled = !connected;
        if (elements.pauseBtn) elements.pauseBtn.disabled = !connected;
    }

    function showError(message) {
        const errorEl = document.createElement("div");
        errorEl.className = "error-message error"; // Add error class for styling
        errorEl.textContent = message;
        document.body.appendChild(errorEl); // Show as a toast/banner
        setTimeout(() => errorEl.remove(), 3000);
        console.error(message);
    }

    // Add these two new functions anywhere in the UTILITY FUNCTIONS section
    function clearHighlights(container) {
        const marks = container.querySelectorAll('mark');
        marks.forEach(mark => {
            const parent = mark.parentNode;
            parent.replaceChild(document.createTextNode(mark.textContent), mark);
            parent.normalize(); // Merges adjacent text nodes
        });
    }

    function performSearch() {
        const searchTerm = elements.searchInput.value;
        const container = elements.serialData;
        clearHighlights(container);

        if (!searchTerm) return;

        const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null, false);
        let node;
        const regex = new RegExp(searchTerm, 'gi');

        while (node = walker.nextNode()) {
            const matches = node.nodeValue.match(regex);
            if (matches) {
                const fragment = document.createDocumentFragment();
                let lastIndex = 0;
                node.nodeValue.replace(regex, (match, offset) => {
                    // Add text before the match
                    fragment.appendChild(document.createTextNode(node.nodeValue.substring(lastIndex, offset)));
                    // Add the highlighted match
                    const mark = document.createElement('mark');
                    mark.textContent = match;
                    fragment.appendChild(mark);
                    lastIndex = offset + match.length;
                });
                // Add any remaining text
                fragment.appendChild(document.createTextNode(node.nodeValue.substring(lastIndex)));
                node.parentNode.replaceChild(fragment, node);
            }
        }
    }

    // ==================== EVENT LISTENERS ====================
    function setupEventListeners() {
        if (elements.connectBtn) elements.connectBtn.addEventListener("click", connectSerial);
        if (elements.disconnectBtn) elements.disconnectBtn.addEventListener("click", disconnectSerial);

        if (elements.pauseBtn) elements.pauseBtn.addEventListener("click", () => {
            state.paused = true;
            elements.pauseBtn.disabled = true;
            elements.continueBtn.disabled = false;
        });

        if (elements.continueBtn) elements.continueBtn.addEventListener("click", () => {
            state.paused = false;
            elements.pauseBtn.disabled = false;
            elements.continueBtn.disabled = true;
        });
        
        if (elements.clearBtn) elements.clearBtn.addEventListener('click', () => {
            if (elements.serialData) {
                elements.serialData.innerHTML = '';
                appendToSerialData("[Log Cleared]\n", "info");
            }
        });

        if (elements.saveBtn) elements.saveBtn.addEventListener('click', () => {
            try {
                const logData = elements.serialData.textContent;
                const blob = new Blob([logData], { type: 'text/plain' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `serial_log_${new Date().toISOString().replace(/:/g, '-')}.txt`;
                document.body.appendChild(a); a.click(); document.body.removeChild(a);
                URL.revokeObjectURL(url);
            } catch (error) { showError("Failed to save log."); }
        });

        if (elements.baudRateSelect) elements.baudRateSelect.addEventListener("change", function() {
            elements.customBaudInput.hidden = this.value !== "custom";
        });
        
        if (elements.searchTransaction) elements.searchTransaction.addEventListener("input", updateTransactionTable);
        if (elements.refreshBtn) elements.refreshBtn.addEventListener("click", () => {
            if (elements.searchTransaction) elements.searchTransaction.value = "";
            updateTransactionTable();
        });
        
        if (elements.exportCsvBtn) elements.exportCsvBtn.addEventListener("click", exportTransactionsToCSV);

        // JSON Separator Controls
        if (elements.pauseSeparatorBtn) {
            elements.pauseSeparatorBtn.addEventListener('click', () => {
                state.separatorPaused = true;
                elements.pauseSeparatorBtn.disabled = true;
                elements.continueSeparatorBtn.disabled = false;
            });
        }

        if (elements.continueSeparatorBtn) {
            elements.continueSeparatorBtn.addEventListener('click', () => {
                state.separatorPaused = false;
                elements.pauseSeparatorBtn.disabled = false;
                elements.continueSeparatorBtn.disabled = true;
                processNewData(); // Process any buffered data immediately
            });
        }

        if (elements.clearSeparatorBtn) {
            elements.clearSeparatorBtn.addEventListener('click', () => {
                elements.jsonData.innerHTML = '';
                state.jsonPacketHistory = [];
            });
        }

        if (elements.saveSeparatorBtn) {
            elements.saveSeparatorBtn.addEventListener('click', () => {
                try {
                    const logData = elements.jsonData.textContent;
                    const blob = new Blob([logData], { type: 'text/plain' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `json_log_${new Date().toISOString().replace(/:/g, '-')}.txt`;
                    document.body.appendChild(a); a.click(); document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                } catch (error) { showError("Failed to save JSON log."); }
            });
        }

        if (elements.searchBtn) {
            elements.searchBtn.addEventListener('click', performSearch);
        }
        if (elements.searchInput) {
            elements.searchInput.addEventListener('keyup', (event) => {
                if (event.key === 'Enter') {
                    performSearch();
                }
            });
        }
        if (elements.clearSearchBtn) {
            elements.clearSearchBtn.addEventListener('click', () => {
                elements.searchInput.value = '';
                clearHighlights(elements.serialData);
            });
        }

        // JSON View and Spacing Controls
        if (elements.toggleJsonViewBtn) {
            elements.toggleJsonViewBtn.addEventListener('change', (e) => {
                state.jsonViewExpanded = e.target.checked;
                redrawJsonPackets();
            });
        }

        if (elements.jsonPacketSpacingInput) {
            elements.jsonPacketSpacingInput.addEventListener('input', (e) => {
                const spacing = e.target.value;
                let styleEl = document.getElementById('dynamic-json-spacing-style');
                if (!styleEl) {
                    styleEl = document.createElement('style');
                    styleEl.id = 'dynamic-json-spacing-style';
                    document.head.appendChild(styleEl);
                }
                styleEl.textContent = `.json-packet { margin-bottom: ${spacing}px !important; }`;
            });
        }
    }


    // ==================== CSV EXPORT ====================
    function exportTransactionsToCSV() {
        try {
            let csvContent = "ID,Connector,ID Tag,Start Time,Stop Time,Meter Start (Wh),Meter Stop (Wh),Energy (Wh),Status,Reason\n";
            const sortedTransactions = Object.entries(state.transactions)
                .sort((a, b) => new Date(b[1].startTime) - new Date(a[1].startTime));
            
            sortedTransactions.forEach(([id, tx]) => {
                const row = [id, tx.connectorId || 1, tx.idTag || '', tx.startTime || '', tx.stopTime || '', 
                tx.meterStart || 0, tx.meterStop || 0, tx.energyWh || 0, tx.status || 'Unknown', tx.reason || '']
                .map(val => `"${String(val).replace(/"/g, '""')}"`) // Quote and escape internal quotes
                .join(',');
                csvContent += row + "\n";
            });
            
            const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.setAttribute("href", url);
            link.setAttribute("download", `transactions_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.csv`);
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        } catch (error) {
            console.error("CSV export failed:", error);
            showError("Failed to export transactions to CSV");
        }
    }
    // ==================== INITIALIZATION ====================
    function initialize() {
        setupEventListeners();
        updateConnectionStatus(false);
        updateTransactionTable();
    }

    initialize();
});