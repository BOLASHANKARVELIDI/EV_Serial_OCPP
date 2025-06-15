class OCPPProcessor {
    constructor() {
        this.transactions = {};
        this.jsonPackets = [];
    }

    processData(rawData) {
        // Extract JSON packets
        const packets = this._extractJsonPackets(rawData);
        
        packets.forEach(packet => {
            try {
                const json = JSON.parse(packet);
                this.jsonPackets.push(json);
                this._processOCPP(json);
            } catch (e) {
                console.warn("Invalid JSON:", packet);
            }
        });
    }

    _extractJsonPackets(str) {
        const packets = [];
        let depth = 0;
        let start = -1;

        for (let i = 0; i < str.length; i++) {
            if (str[i] === '[') {
                if (depth === 0) start = i;
                depth++;
            } else if (str[i] === ']') {
                depth--;
                if (depth === 0 && start !== -1) {
                    packets.push(str.substring(start, i + 1));
                    start = -1;
                }
            }
        }
        return packets;
    }

    _processOCPP(packet) {
        if (!Array.isArray(packet)) return;

        const [messageType, messageId, action, payload] = packet;

        if (messageType === 2) { // Request
            if (action === "StartTransaction") {
                this._handleStartTransaction(payload);
            } else if (action === "StopTransaction") {
                this._handleStopTransaction(payload);
            }
        } else if (messageType === 3) { // Response
            this._handleResponse(messageId, payload);
        }
    }

    _handleStartTransaction(payload) {
        const txId = `${payload.idTag}-${payload.timestamp}`;
        this.transactions[txId] = {
            idTag: payload.idTag,
            meterStart: payload.meterStart,
            startTime: new Date(payload.timestamp),
            status: "Started"
        };
    }

    _handleStopTransaction(payload) {
        const tx = this.transactions[payload.transactionId];
        if (tx) {
            tx.meterStop = payload.meterStop;
            tx.stopTime = new Date(payload.timestamp);
            tx.status = "Completed";
            tx.energyUsed = tx.meterStop - tx.meterStart;
        }
    }

    _handleResponse(messageId, payload) {
        // Handle responses if needed
    }

    getTransactions() {
        return Object.values(this.transactions);
    }

    getJsonPackets() {
        return this.jsonPackets;
    }
}