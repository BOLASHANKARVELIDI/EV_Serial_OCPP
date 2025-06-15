class AppController {
    constructor() {
        this.serialManager = new SerialManager();
        this.ocppProcessor = new OCPPProcessor();
        this.initializeUI();
        this.setupEventListeners();
    }

    initializeUI() {
        // Initialize Chart
        this.powerChart = new Chart(document.getElementById('power-chart'), {
            type: 'line',
            data: { datasets: [{ label: 'Power (W)' }] }
        });
    }

    setupEventListeners() {
        // Serial events
        addEventListener('serialData', (e) => {
            if (!this.serialPaused) {
                document.getElementById('serial-data').textContent += e.detail;
            }
        });

        // JSON Packet Handler
        document.addEventListener('jsonPackets', (e) => {
            if (this.jsonPaused) return;
            
            const jsonContainer = document.getElementById('json-data');
            const wasScrolledToBottom = this.isScrolledToBottom(jsonContainer);
            
            e.detail.forEach(rawJson => {
                try {
                    const packet = JSON.parse(rawJson);
                    const html = this.createJsonPacketElement(rawJson, packet);
                    jsonContainer.insertAdjacentHTML('beforeend', html);
                } catch (error) {
                    console.warn("Failed to parse JSON:", rawJson);
                }
            });
            
            if (wasScrolledToBottom) {
                jsonContainer.scrollTop = jsonContainer.scrollHeight;
            }
        });

        // Button events
        document.getElementById('connect-btn').addEventListener('click', this.connect.bind(this));
        document.getElementById('disconnect-btn').addEventListener('click', this.disconnect.bind(this));
        document.getElementById('pause-btn').addEventListener('click', this.togglePause.bind(this));
        // ... other event listeners
    }

    async connect() {
        const baudRate = parseInt(document.getElementById('baud-rate').value);
        const connected = await this.serialManager.connect(baudRate);
        if (connected) {
            document.getElementById('connection-status').textContent = "🟢 Connected";
            // Update other UI states
        }
    }

    updateJsonDisplay(rawJson, parsedJson) {
        const jsonContainer = document.getElementById('json-data');
        const timestamp = new Date().toLocaleTimeString();
        
        jsonContainer.innerHTML += `
            <div class="json-packet">
                <div class="json-header">
                    <span>${timestamp}</span>
                    <strong>${parsedJson[2] || 'Unknown'}</strong>
                </div>
                <pre>${rawJson}</pre>
            </div>
        `;
        
        if (this.autoScroll) {
            jsonContainer.scrollTop = jsonContainer.scrollHeight;
        }
    }

    updateTransactionDisplay() {
        const transactions = this.ocppProcessor.getTransactions();
        const tableBody = document.getElementById('transactions-table').querySelector('tbody');
        
        tableBody.innerHTML = transactions.map(tx => `
            <tr>
                <td>${tx.transactionId || 'Pending'}</td>
                <td>${tx.idTag}</td>
                <td>${new Date(tx.startTime).toLocaleString()}</td>
                <td>${tx.stopTime ? new Date(tx.stopTime).toLocaleString() : '-'}</td>
                <td>${tx.totalEnergy || (tx.meterStop - tx.meterStart) || '-'}</td>
                <td>${tx.status}</td>
            </tr>
        `).join('');

        // Update chart
        this.updatePowerChart();
    }

    updatePowerChart() {
        // Implement chart update logic
    }

    
    createJsonPacketElement(rawJson, parsedJson) {
        const timestamp = new Date().toLocaleTimeString();
        const messageType = parsedJson[0] === 2 ? 'Request' : 'Response';
        const action = parsedJson[2] || 'Unknown';
        
        return `
            <div class="json-packet">
                <div class="json-header">
                    <span class="timestamp">${timestamp}</span>
                    <span class="message-type">${messageType}</span>
                    <span class="action">${action}</span>
                </div>
                <pre>${this.syntaxHighlight(rawJson)}</pre>
            </div>
        `;
    }

    syntaxHighlight(json) {
        return json
            .replace(/("[^"]*"):/g, '<span class="json-key">$1</span>:')
            .replace(/"([^"]*)"/g, '<span class="json-string">"$1"</span>')
            .replace(/\b(true|false|null)\b/g, '<span class="json-literal">$1</span>')
            .replace(/\b\d+\b/g, '<span class="json-number">$&</span>');
    }

    isScrolledToBottom(element) {
        return element.scrollHeight - element.scrollTop <= element.clientHeight + 10;
    }
}

// Start application
new AppController();