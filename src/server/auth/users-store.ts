import matter from "gray-matter";

export interface AuthUser {
	email: string;
	name: string;
	role: "admin" | "viewer";
	apiKey?: string;
}

/**
 * Reads and parses a users.md file containing user definitions in YAML
 * frontmatter. Provides case-insensitive email lookup for authentication.
 *
 * @author waabox(waabox[at]gmail[dot]com)
 */
export class UsersStore {
	private readonly filePath: string;
	private users = new Map<string, AuthUser>();
	private apiKeys = new Map<string, AuthUser>();

	constructor(filePath: string) {
		this.filePath = filePath;
	}

	/**
	 * Loads users from the configured users.md file. Clears any previously
	 * loaded data before parsing. If the file does not exist, the store
	 * remains empty without error.
	 *
	 * Each user entry must have at least an email and name (strings).
	 * If the role is not "admin", it defaults to "viewer".
	 */
	async load(): Promise<void> {
		this.users.clear();
		this.apiKeys.clear();

		const file = Bun.file(this.filePath);
		if (!(await file.exists())) {
			return;
		}

		const raw = await file.text();
		const { data } = matter(raw);

		if (!Array.isArray(data.users)) {
			return;
		}

		for (const entry of data.users) {
			if (typeof entry?.email !== "string" || typeof entry?.name !== "string") {
				continue;
			}

			const email = entry.email.trim();
			const name = entry.name.trim();

			if (email.length === 0 || name.length === 0) {
				continue;
			}

			const role: "admin" | "viewer" =
				typeof entry.role === "string" && entry.role.toLowerCase() === "admin" ? "admin" : "viewer";
			const apiKey = typeof entry.apiKey === "string" ? entry.apiKey.trim() : "";

			const user: AuthUser = { email, name, role, ...(apiKey.length > 0 ? { apiKey } : {}) };
			this.users.set(email.toLowerCase(), user);
			if (apiKey.length > 0) {
				this.apiKeys.set(apiKey, user);
			}
		}
	}

	/**
	 * Looks up a user by email address. The lookup is case-insensitive.
	 *
	 * @param email The email to search for
	 * @returns The matching AuthUser or null if not found
	 */
	findByEmail(email: string): AuthUser | null {
		return this.users.get(email.toLowerCase()) ?? null;
	}

	/**
	 * Looks up a user by API key. Returns null if the key is empty
	 * or not found.
	 *
	 * @param apiKey The API key to search for
	 * @returns The matching AuthUser or null if not found
	 */
	findByApiKey(apiKey: string): AuthUser | null {
		if (apiKey.length === 0) return null;
		return this.apiKeys.get(apiKey) ?? null;
	}

	/**
	 * Returns all loaded users.
	 *
	 * @returns Array of all AuthUser entries
	 */
	listAll(): AuthUser[] {
		return Array.from(this.users.values());
	}
}
