/**
 * A single-flight mutex.
 *
 * Every mutating operation (backup, restore, sync, rollback) takes the same
 * lock: two of them writing the same work tree or the same profile patch would
 * corrupt both, and the settings page and an agent tool can be triggered at the
 * same moment.
 * @module core/mutex
 */
/** Create one mutex. */
export function createMutex() {
    let current = null;
    let queue = [];
    const acquire = (owner) => {
        if (current === null) {
            current = owner;
            return Promise.resolve(releaseFor(owner));
        }
        return new Promise(resolve => {
            queue.push(() => resolve(releaseFor(owner)));
        });
    };
    const releaseFor = (owner) => {
        let released = false;
        return () => {
            if (released)
                return;
            released = true;
            if (current !== owner)
                return;
            current = null;
            const next = queue.shift();
            if (next !== undefined)
                next();
        };
    };
    return {
        tryAcquire(owner) {
            if (current !== null)
                return null;
            current = owner;
            return releaseFor(owner);
        },
        holder() {
            return current;
        },
        async run(owner, task) {
            const release = await acquire(owner);
            try {
                return await task();
            }
            finally {
                release();
            }
        },
    };
}
