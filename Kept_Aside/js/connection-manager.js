class SerialConnection {
    constructor() {
        this.port = null;
        this.reader = null;
        this.writer = null;
        this.onDataCallback = null;
        this.onDisconnectCallback = null;
    }

    async connect(baudRate = 115200) {
        try {
            this.port = await navigator.serial.requestPort();
            await this.port.open({ baudRate });
            
            this.reader = this.port.readable.getReader();
            this.writer = this.port.writable.getWriter();
            
            this._readLoop();
            return true;
        } catch (error) {
            console.error("Connection failed:", error);
            return false;
        }
    }

    async disconnect() {
        if (this.reader) {
            await this.reader.cancel();
            this.reader.releaseLock();
            this.reader = null;
        }
        if (this.writer) {
            this.writer.releaseLock();
            this.writer = null;
        }
        if (this.port) {
            await this.port.close();
            this.port = null;
        }
        if (this.onDisconnectCallback) {
            this.onDisconnectCallback();
        }
    }

    async send(data) {
        if (!this.writer) return false;
        const encoder = new TextEncoder();
        await this.writer.write(encoder.encode(data + '\n'));
        return true;
    }

    async _readLoop() {
        const decoder = new TextDecoder();
        try {
            while (true) {
                const { value, done } = await this.reader.read();
                if (done) break;
                const text = decoder.decode(value);
                if (this.onDataCallback) {
                    this.onDataCallback(text);
                }
            }
        } catch (error) {
            console.error("Read error:", error);
        } finally {
            this.disconnect();
        }
    }
}