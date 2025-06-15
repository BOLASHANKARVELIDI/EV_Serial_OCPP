class SerialManager {
    constructor() {
        this.port = null;
        this.reader = null;
        this.keepReading = false;
        this.paused = false;
        this.jsonParser = new JSONParser();
        this.rawBuffer = "";
    }

    async connect(baudRate) {
        try {
            this.port = await navigator.serial.requestPort();
            await this.port.open({ baudRate, bufferSize: 1000000 });
            
            this.keepReading = true;
            this.reader = this.port.readable.getReader();
            this._readLoop();
            
            return true;
        } catch (error) {
            console.error("Connection failed:", error);
            return false;
        }
    }

    async _readLoop() {
        const decoder = new TextDecoder();
        while (this.keepReading && !this.paused) {
            try {
                const { value, done } = await this.reader.read();
                if (done) break;
                
                const text = decoder.decode(value);

                // Dispatch raw data
                this.dispatchSerialData(text);
                
                // Process for JSON
                const packets = this.jsonParser.extractCompletePackets(text);
                if (packets.length > 0) {
                    this.dispatchJsonPackets(packets);
                }
                
            } catch (error) {
                console.error("Read error:", error);
                this.disconnect();
            }
        }
    }
    
    dispatchSerialData(text) {
        const event = new CustomEvent('serialData', { 
            detail: text,
            bubbles: true
        });
        document.dispatchEvent(event);
    }

    dispatchJsonPackets(packets) {
        const event = new CustomEvent('jsonPackets', {
            detail: packets.map(p => p.raw),
            bubbles: true
        });
        document.dispatchEvent(event);
    }

    async disconnect() {
        this.keepReading = false;
        if (this.reader) {
            await this.reader.cancel();
            this.reader.releaseLock();
        }
        if (this.port) await this.port.close();
    }
}

class JSONParser {
    constructor() {
        this.buffer = "";
        this.packets = [];
    }

    // Modified to handle streaming data better
    extractCompletePackets(data) {
        this.buffer += data;
        const packets = [];
        let start = -1;
        let braceCount = 0;
        let bracketCount = 0;
        let inString = false;

        for (let i = 0; i < this.buffer.length; i++) {
            const char = this.buffer[i];

            // Handle string literals
            if (char === '"' && (i === 0 || this.buffer[i-1] !== '\\')) {
                inString = !inString;
                continue;
            }

            if (!inString) {
                if (char === '[' || char === '{') {
                    if (start === -1) start = i;
                    char === '[' ? bracketCount++ : braceCount++;
                } else if (char === ']' || char === '}') {
                    char === ']' ? bracketCount-- : braceCount--;
                    
                    // Found complete packet
                    if (bracketCount === 0 && braceCount === 0 && start !== -1) {
                        try {
                            const packet = this.buffer.slice(start, i + 1);
                            JSON.parse(packet); // Validate JSON
                            packets.push({
                                raw: packet,
                                start,
                                end: i + 1
                            });
                            start = -1;
                        } catch (e) {
                            console.warn("Invalid JSON at position", start);
                        }
                    }
                }
            }
        }

        // Remove processed data from buffer
        if (packets.length > 0) {
            this.buffer = this.buffer.slice(packets[packets.length-1].end);
        }

        return packets;
    }
}