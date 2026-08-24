/**
 * Google Picker for Drive folder selection. The only place this app loads
 * remote code (ADR-0013 exception to ADR-0001). Fetched on click, not on page
 * load, and remembered for the session so a second pick does not refetch.
 */

let gapiReady = false;
let gapiPromise: Promise<void> | null = null;

function loadGapi(): Promise<void> {
  if (gapiReady) return Promise.resolve();
  if (gapiPromise) return gapiPromise;

  const { promise, resolve, reject } = Promise.withResolvers<void>();

  const script = document.createElement("script");
  script.src = "https://apis.google.com/js/api.js";
  script.async = true;
  script.onload = () => {
    const gapi = (
      window as unknown as {
        gapi?: {
          load: (name: string, opts: { callback: () => void; onerror?: () => void }) => void;
        };
      }
    ).gapi;
    if (!gapi) {
      reject(new Error("Google API loader did not initialise"));
      return;
    }
    gapi.load("picker", {
      callback: () => {
        gapiReady = true;
        resolve();
      },
      onerror: () => reject(new Error("Failed to load Google Picker")),
    });
  };
  script.onerror = () =>
    reject(
      new Error("Failed to reach Google's picker script — check your connection and try again."),
    );
  document.head.appendChild(script);

  gapiPromise = promise;
  promise.catch(() => {
    gapiPromise = null;
  });

  return promise;
}

/**
 * Open the Drive folder picker. Returns the chosen folder's id and name, or
 * null if the user cancelled. Rejects if the Picker script cannot be reached.
 *
 * No developer key and no appId: an API key authorises public-data views while
 * this picker is private-data access authorised by the OAuth token; setAppId is
 * for the drive.file scope while this app holds drive.
 */
export async function pickDriveFolder(
  oauthToken: string,
): Promise<{ id: string; name: string } | null> {
  await loadGapi();

  const { promise, resolve, reject } = Promise.withResolvers<{ id: string; name: string } | null>();

  try {
    const g = window as unknown as {
      google?: {
        picker?: {
          DocsView: new (viewId: unknown) => {
            setMimeTypes: (m: string) => { setSelectFolderEnabled: (b: boolean) => unknown };
          };
          ViewId: { FOLDERS: unknown };
          PickerBuilder: new () => {
            setOAuthToken: (token: string) => unknown;
            addView: (view: unknown) => unknown;
            setCallback: (
              cb: (data: { action: string; docs?: Array<{ id: string; name: string }> }) => void,
            ) => unknown;
            build: () => { setVisible: (v: boolean) => void };
          };
          Action: { PICKED: string; CANCEL: string };
        };
      };
    };

    const pickerNs = g.google?.picker;
    if (!pickerNs) {
      reject(new Error("Google Picker not available after load"));
      return promise;
    }

    const view = new pickerNs.DocsView(pickerNs.ViewId.FOLDERS)
      .setMimeTypes("application/vnd.google-apps.folder")
      .setSelectFolderEnabled(true) as unknown as object;

    // Use any for builder chaining to avoid verbose typing.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyBuilder = new (pickerNs.PickerBuilder as unknown as new () => unknown)() as any;
    const anyView = view as unknown as object;
    const picker = anyBuilder
      .setOAuthToken(oauthToken)
      .addView(anyView)
      .setCallback((data: { action: string; docs?: Array<{ id: string; name: string }> }) => {
        if (data.action === pickerNs.Action.PICKED && data.docs && data.docs.length > 0) {
          const doc = data.docs[0];
          resolve({ id: doc.id, name: doc.name });
        } else if (data.action === pickerNs.Action.CANCEL) {
          resolve(null);
        }
      })
      .build() as { setVisible: (v: boolean) => void };

    picker.setVisible(true);
  } catch (error) {
    reject(error instanceof Error ? error : new Error(String(error)));
  }

  return promise;
}

/** Exposed for tests to reset the remembered load state. */
export function __resetPickerForTests(): void {
  gapiReady = false;
  gapiPromise = null;
}
