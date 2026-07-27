# D-Bus Communication in GNOME Shell Extensions

Use D-Bus to communicate between the GNOME Shell extension process and external processes, or to invoke system/session services.

## 1. Calling DBus Interfaces (High-Level Wrapper)

The easiest way to call a DBus service in GJS is using `Gio.DBusProxy.makeProxyWrapper`:

```js
import Gio from "gi://Gio";

// 1. Define the DBus XML Interface
const MyInterfaceXml = `
<node>
  <interface name="org.example.MyService">
    <method name="SayHello">
      <arg type="s" name="name" direction="in"/>
      <arg type="s" name="greeting" direction="out"/>
    </method>
    <signal name="StatusChanged">
      <arg type="b" name="status"/>
    </signal>
  </interface>
</node>
`;

// 2. Create the Proxy Wrapper Class
const MyServiceProxy = Gio.DBusProxy.makeProxyWrapper(MyInterfaceXml);

// 3. Instantiate the Proxy
export class MyDbusClient {
    constructor() {
        this._proxy = new MyServiceProxy(
            Gio.DBus.session, // Session bus (or Gio.DBus.system)
            'org.example.MyService', // DBus Bus Name
            '/org/example/MyService' // DBus Object Path
        );

        // Connect to signals
        this._signalId = this._proxy.connectSignal('StatusChanged', (proxy, senderName, [status]) => {
            console.log(`Status changed: ${status}`);
        });
    }

    async callSayHello(name) {
        return new Promise((resolve, reject) => {
            // Proxy methods are generated automatically
            this._proxy.SayHelloRemote(name, (result, error) => {
                if (error) {
                    reject(error);
                } else {
                    resolve(result[0]); // Returns array of out arguments
                }
            });
        });
    }

    destroy() {
        if (this._signalId) {
            this._proxy.disconnectSignal(this._signalId);
            this._signalId = null;
        }
        this._proxy = null;
    }
}
```

## 2. Exposing/Exporting DBus Interfaces from GNOME Shell

To let external applications call methods inside your extension:

```js
import Gio from "gi://Gio";

const MyExtensionInterfaceXml = `
<node>
  <interface name="org.gnome.Shell.Extensions.MyExtension">
    <method name="ToggleState">
      <arg type="b" name="state" direction="in"/>
    </method>
  </interface>
</node>
`;

export class MyDbusServer {
    constructor(extension) {
        this._extension = extension;
        this._dbusImpl = Gio.DBusExportedObject.wrapJSObject(
            MyExtensionInterfaceXml,
            this
        );
        
        // Export the interface
        this._dbusImpl.export(Gio.DBus.session, '/org/gnome/Shell/Extensions/MyExtension');
    }

    // Method names in XML correspond to JS methods
    ToggleState(state) {
        console.log(`D-Bus ToggleState called with: ${state}`);
        this._extension.setEnabled(state);
    }

    destroy() {
        this._dbusImpl.unexport();
        this._dbusImpl = null;
    }
}
```
