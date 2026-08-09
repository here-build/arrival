// Example TypeScript file to test the MCP server

interface User {
  id: number;
  name: string;
  email: string;
}

class UserService {
  private users: User[] = [];

  /**
   * Add a new user to the service
   * @param user The user to add
   */
  addUser(user: User): void {
    this.users.push(user);
  }

  /**
   * Find a user by ID
   * @param id The user ID to search for
   * @returns The user if found, undefined otherwise
   */
  findUser(id: number): User | undefined {
    return this.users.find(u => u.id === id);
  }
}

// Example usage
const service = new UserService();
const testUser: User = {
  id: 1,
  name: "Test User",
  email: "test@example.com"
};

service.addUser(testUser);
const found = service.findUser(1);
console.log(found);