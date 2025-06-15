document.addEventListener("DOMContentLoaded", function() {
    // ==================== CONFIGURATION ====================
    const config = {
        bufferSize: 1000000,
        scrollThreshold: 100,
        reconnectDelay: 2000,
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
        requestResponseMap: {}
    };

    // ==================== DOM ELEMENTS ====================
    const elements = {
        serialData: document.getElementById("serial-data"),
        jsonData: document.getElementById("json-data"),
        transactionBody: document.getElementById("transaction-body"),
        connectionStatus: document.getElementById("connection-status"),
        connectBtn: document.getElementById("connect-btn"),
        disconnectBtn: document.getElementById("disconnect-btn"),
        pauseBtn: document.getElementById("pause-btn"),
        continueBtn: document.getElementById("continue-btn"),
        baudRateSelect: document.getElementById("baud-rate"),
        customBaudInput: document.getElementById("custom-baud"),
        searchTransaction: document.getElementById("search-transaction"),
        refreshBtn: document.getElementById("refresh-btn")
    };

    // ==================== SERIAL COMMUNICATION ====================
    async function connectSerial() {
        try {
            // Check Web Serial API support
            if (!navigator.serial) {
                throw new Error("Web Serial API not supported in your browser");
            }

            // Request port access
            state.port = await navigator.serial.requestPort();
            if (!state.port) {
                throw new Error("No port selected");
            }

            // Open port with selected baud rate
            const baudRate = getBaudRate();
            await state.port.open({ baudRate, bufferSize: config.bufferSize });

            // Update UI state
            state.keepReading = true;
            updateConnectionStatus(true);
            setButtonStates(true);

            // Start reading data
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
                        const text = textDecoder.decode(value);
                        state.rawDataBuffer += text;
                        appendToSerialData(text);
                        processNewData();
                    }
                } catch (readError) {
                    console.error("Read error:", readError);
                    appendToSerialData(`\n[Read Error: ${readError.message}]\n`, "error");
                    
                    // Attempt to reconnect if it's a connection error
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
            }
        }
    }

    // ==================== DATA PROCESSING ====================
    function processNewData() {
        if (state.separatorPaused || !state.rawDataBuffer) return;

        // Remove any newlines that might break JSON parsing
        const cleanData = state.rawDataBuffer.replace(/\r?\n|\r/g, "");
        const jsonPackets = extractJsonPackets(cleanData);
        
        if (jsonPackets.length > 0) {
            const wasScrolledToBottom = isScrolledToBottom(elements.jsonData);
            
            jsonPackets.forEach(packet => {
                try {
                    const json = JSON.parse(packet);
                    if (Array.isArray(json) && (json[0] === 2 || json[0] === 3)) {
                        displayJsonPacket(packet, json);
                        processOcppPacket(json);
                    }
                } catch (e) {
                    console.warn("Invalid JSON:", packet);
                    appendToSerialData(`\n[Invalid JSON: ${packet}]\n`, "warning");
                }
            });

            if (wasScrolledToBottom) {
                elements.jsonData.scrollTop = elements.jsonData.scrollHeight;
            }
            
            // Remove processed data from buffer
            const lastPacket = jsonPackets[jsonPackets.length - 1];
            const processedLength = state.rawDataBuffer.lastIndexOf(lastPacket) + lastPacket.length;
            state.rawDataBuffer = state.rawDataBuffer.slice(processedLength);
        }
    }

    function extractJsonPackets(str) {
        const packets = [];
        let buffer = "";
        let inJson = false;
        let braceCount = 0;
        let bracketCount = 0;
        
        for (let i = 0; i < str.length; i++) {
            const char = str[i];
            
            // Handle OCPP packets that start with [2 or [3
            if (!inJson && char === '[' && (str[i+1] === '2' || str[i+1] === '3')) {
                inJson = true;
                buffer = char;
                bracketCount = 1;
                continue;
            }
            
            if (inJson) {
                buffer += char;
                
                // Count brackets/braces to find matching pairs
                if (char === '[') bracketCount++;
                if (char === ']') bracketCount--;
                if (char === '{') braceCount++;
                if (char === '}') braceCount--;
                
                // When we find a complete packet
                if (bracketCount === 0 && braceCount === 0) {
                    packets.push(buffer);
                    buffer = "";
                    inJson = false;
                    braceCount = 0;
                    bracketCount = 0;
                }
            }
        }
        
        return packets;
    }


    function isOcppPacket(json) {
        return Array.isArray(json) && (json[0] === 2 || json[0] === 3);
    }

    // ==================== OCPP PROCESSING ====================
    function processOcppPacket(packet) {
        if (!isOcppPacket(packet)) return;

        try {
            const messageType = packet[0];
            const messageId = packet[1] || "unknown";

            if (messageType === 2) { // Request
                const action = packet[2];
                const payload = packet[3] || {};

                state.requestResponseMap[messageId] = packet;

                switch (action) {
                    case "StartTransaction":
                        handleStartTransaction(payload);
                        break;
                    case "StopTransaction":
                        handleStopTransaction(payload);
                        break;
                    case "MeterValues":
                        handleMeterValues(payload);
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
                    else if (requestAction === "StopTransaction") {
                        handleStopTransactionResponse(requestPacket, responsePayload);
                    }
                }
            }
        } catch (error) {
            console.error("OCPP Processing Error:", error);
            appendToSerialData(`\n[OCPP Error: ${error.message}]\n`, "error");
        }
    }

    // ==================== TRANSACTION HANDLERS ====================
    function handleStartTransaction(payload = {}) {
        const transactionId = payload.transactionId;
        if (!transactionId) return;

        state.transactions[transactionId] = {
            connectorId: payload.connectorId || 1,
            idTag: payload.idTag || "-",
            startTime: new Date().toLocaleString(),
            meterStart: payload.meterStart || 0,
            status: "Active",
            meterStop: 0,
            energyWh: 0,
            reason: "-"
        };
        
        updateTransactionTable();
    }

    function handleStopTransaction(payload = {}) {
        const transactionId = payload.transactionId;
        if (!transactionId || !state.transactions[transactionId]) return;

        state.transactions[transactionId] = {
            ...state.transactions[transactionId],
            stopTime: new Date().toLocaleString(),
            meterStop: payload.meterStop || state.transactions[transactionId].meterStart,
            energyWh: (payload.meterStop || 0) - (state.transactions[transactionId].meterStart || 0),
            status: "Completed",
            reason: payload.reason || "Normal"
        };
        
        updateTransactionTable();
    }

    // ==================== UI FUNCTIONS ====================
    function displayJsonPacket(rawJson, parsedJson) {
        if (!elements.jsonData) return;

        const timestamp = new Date().toLocaleTimeString();
        let messageType, action;
        
        try {
            messageType = parsedJson[0] === 2 ? "Request" : "Response";
            action = parsedJson[2] || "Unknown";
        } catch (e) {
            console.warn("Invalid OCPP packet structure:", parsedJson);
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
            <pre>${syntaxHighlightJSON(rawJson)}</pre>
        `;
        
        elements.jsonData.appendChild(packetEl);
    }

    function updateTransactionTable() {
        if (!elements.transactionBody || !elements.searchTransaction) return;

        try {
            elements.transactionBody.innerHTML = '';
            const searchTerm = elements.searchTransaction.value.toLowerCase();

            Object.entries(state.transactions).forEach(([id, tx]) => {
                if (searchTerm && !id.toLowerCase().includes(searchTerm)) return;

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
                    <td class="status-${tx.status?.toLowerCase() || "active"}">${tx.status || "Active"}</td>
                    <td>${tx.reason || "-"}</td>
                `;
                elements.transactionBody.appendChild(row);
            });
        } catch (error) {
            console.error("Transaction table error:", error);
        }
    }

    // ==================== UTILITY FUNCTIONS ====================
    function appendToSerialData(text, className = "") {
        if (!text.trim() || !elements.serialData) return;

        try {
            const div = document.createElement("div");
            if (className) div.className = className;
            div.textContent = text;
            elements.serialData.appendChild(div);

            if (state.autoScroll) {
                elements.serialData.scrollTop = elements.serialData.scrollHeight;
            }
        } catch (error) {
            console.error("Append error:", error);
        }
    }

    function syntaxHighlightJSON(json) {
        if (!json) return '';
        return json
            .replace(/("[^"]+"):/g, '<span class="json-key">$1</span>:')
            .replace(/"([^"]+)"/g, '<span class="json-string">"$1"</span>')
            .replace(/\b(true|false|null)\b/g, '<span class="json-boolean">$1</span>')
            .replace(/\b\d+\b/g, '<span class="json-number">$&</span>');
    }

    function getBaudRate() {
        try {
            return elements.baudRateSelect.value === "custom" 
                ? parseInt(elements.customBaudInput.value) || config.defaultBaudRate
                : parseInt(elements.baudRateSelect.value) || config.defaultBaudRate;
        } catch (error) {
            console.error("Baud rate error:", error);
            return config.defaultBaudRate;
        }
    }

    function updateConnectionStatus(connected) {
        if (!elements.connectionStatus) return;
        elements.connectionStatus.textContent = connected ? "🟢 Connected" : "🔴 Disconnected";
        elements.connectionStatus.className = connected ? "status-connected" : "status-disconnected";
    }

    function isScrolledToBottom(element) {
        return element && (element.scrollHeight - element.scrollTop <= element.clientHeight + config.scrollThreshold);
    }

    function isConnectionError(error) {
        return error.message.includes("disconnected") || 
               error.message.includes("closed") ||
               error.message.includes("failed");
    }

    async function attemptReconnect() {
        appendToSerialData("\n[Attempting to reconnect...]\n", "warning");
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
        errorEl.className = "error-message";
        errorEl.textContent = message;
        elements.serialData.appendChild(errorEl);
        console.error(message);
    }

    // ==================== EVENT LISTENERS ====================
    function setupEventListeners() {
        // Connection controls
        if (elements.connectBtn) {
            elements.connectBtn.addEventListener("click", connectSerial);
        }
        if (elements.disconnectBtn) {
            elements.disconnectBtn.addEventListener("click", disconnectSerial);
        }
        
        // Pause/continue
        if (elements.pauseBtn) {
            elements.pauseBtn.addEventListener("click", () => {
                state.paused = true;
                if (elements.pauseBtn) elements.pauseBtn.disabled = true;
                if (elements.continueBtn) elements.continueBtn.disabled = false;
            });
        }
        if (elements.continueBtn) {
            elements.continueBtn.addEventListener("click", () => {
                state.paused = false;
                if (elements.pauseBtn) elements.pauseBtn.disabled = false;
                if (elements.continueBtn) elements.continueBtn.disabled = true;
            });
        }

        // Baud rate
        if (elements.baudRateSelect && elements.customBaudInput) {
            elements.baudRateSelect.addEventListener("change", function() {
                elements.customBaudInput.hidden = this.value !== "custom";
            });
        }

        // Transaction search
        if (elements.searchTransaction) {
            elements.searchTransaction.addEventListener("input", updateTransactionTable);
        }

        if (elements.refreshBtn) {
            elements.refreshBtn.addEventListener("click", () => {
                if (elements.searchTransaction) elements.searchTransaction.value = "";
                updateTransactionTable();
            });
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