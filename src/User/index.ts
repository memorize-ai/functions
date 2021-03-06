import firebase from 'firebase-admin'
import { v4 as uuid } from 'uuid'
import { nanoid } from 'nanoid'

import Notifications, { DEFAULT_USER_NOTIFICATIONS } from './Notifications'
import {
	createNotifications,
	NotificationOptions
} from '../Notifications/Notification'
import Deck from '../Deck'
import { sendEmail, EmailTemplate, EmailUser, DEFAULT_FROM } from '../Email'
import { slugify } from '../utils'

const { FieldValue } = firebase.firestore

const auth = firebase.auth()
const firestore = firebase.firestore()

const tokenCache: Record<string, string[]> = {}

export type UserSource = 'web' | 'ios'

export default class User {
	static readonly SLUG_ID_LENGTH = 10

	static xp = {
		deckDownload: 1,
		reviewCard: 1,

		rating_1: -5,
		rating_2: -2,
		rating_3: 1,
		rating_4: 4,
		rating_5: 10
	}

	id: string
	slugId: string | null
	slug: string | null
	hasImage: boolean
	name: string
	email: string
	source: UserSource
	allowContact: boolean
	isMuted: boolean
	apiKey: string | null
	numberOfDecks: number
	interests: string[]
	allDecks: string[]
	notifications: Notifications

	constructor(snapshot: FirebaseFirestore.DocumentSnapshot) {
		if (!snapshot.exists)
			throw new Error(`There are no users with ID "${snapshot.id}"`)

		this.id = snapshot.id
		this.slugId = snapshot.get('slugId') ?? null
		this.slug = snapshot.get('slug') ?? null
		this.hasImage = snapshot.get('hasImage') ?? false
		this.name = snapshot.get('name')
		this.email = snapshot.get('email')
		this.source = snapshot.get('source') ?? 'ios'
		this.allowContact = snapshot.get('allowContact') ?? true
		this.isMuted = snapshot.get('muted') ?? false
		this.apiKey = snapshot.get('apiKey') ?? null
		this.numberOfDecks = snapshot.get('deckCount') ?? 0
		this.interests = snapshot.get('topics') ?? []
		this.allDecks = snapshot.get('allDecks') ?? []

		this.notifications =
			snapshot.get('notifications') ?? DEFAULT_USER_NOTIFICATIONS

		this.notifications.type ??= DEFAULT_USER_NOTIFICATIONS.type
		this.notifications.fixed ??= DEFAULT_USER_NOTIFICATIONS.fixed
		this.notifications.fixed.days ??= DEFAULT_USER_NOTIFICATIONS.fixed.days
		this.notifications.fixed.time ??= DEFAULT_USER_NOTIFICATIONS.fixed.time
	}

	static fromId = async (id: string) =>
		new User(await firestore.doc(`users/${id}`).get())

	static fromEmail = async (email: string) => {
		const { docs } = await firestore
			.collection('users')
			.where('email', '==', email)
			.limit(1)
			.get()

		const snapshot = docs[0]

		if (snapshot) return new User(snapshot)

		throw new Error(`There are no users with email "${email}"`)
	}

	static incrementDeckCount = (uid: string, amount = 1) =>
		firestore.doc(`users/${uid}`).update({
			deckCount: FieldValue.increment(amount)
		})

	static decrementDeckCount = (uid: string, amount = 1) =>
		User.incrementDeckCount(uid, -amount)

	static addXP = (uid: string, amount = 1) =>
		firestore.doc(`users/${uid}`).update({
			xp: FieldValue.increment(amount)
		})

	static subtractXP = (uid: string, amount = 1) => User.addXP(uid, -amount)

	static incrementCounter = (amount = 1) =>
		firestore.doc('counters/users').update({
			value: FieldValue.increment(amount)
		})

	static decrementCounter = (amount = 1) => User.incrementCounter(-amount)

	static incrementCreatedDeckCount = (uid: string, amount = 1) =>
		firestore.doc(`users/${uid}`).update({
			createdDeckCount: FieldValue.increment(amount)
		})

	static decrementCreatedDeckCount = (uid: string, amount = 1) =>
		User.incrementCreatedDeckCount(uid, -amount)

	sendSignUpNotification = async () => {
		await sendEmail({
			template: EmailTemplate.UserSignUpNotification,
			to: DEFAULT_FROM,
			replyTo: this.emailUser,
			context: {
				user: {
					id: this.id,
					name: this.name,
					email: this.email,
					source: this.source === 'web' ? 'Web' : 'iOS'
				}
			}
		})
	}

	onCreate = async () => {
		this.apiKey = uuid()

		await Promise.all([
			User.incrementCounter(),
			this.normalizeDisplayName(),
			this.sendSignUpNotification(),
			this.createUserData(),
			this.createApiKey()
		])
	}

	onDelete = async () => {
		await Promise.all([
			this.removeAuth(),
			this.removeApiKey(),
			this.removeCreatedDecks()
		])
	}

	getCreatedDecks = async () => {
		const { docs } = await firestore
			.collection('decks')
			.where('creator', '==', this.id)
			.get()

		return docs.map(snapshot => new Deck(snapshot))
	}

	indexCreatedDecks = async () => {
		await Deck.index(await this.getCreatedDecks(), this)
	}

	removeCreatedDecks = async () => {
		const decks = await this.getCreatedDecks()

		await Promise.all(
			decks.map(({ id }) => firestore.doc(`decks/${id}`).delete())
		)
	}

	addDeckToAllDecks = (deckId: string) =>
		firestore.doc(`users/${this.id}`).update({
			allDecks: FieldValue.arrayUnion(deckId)
		})

	removeDeckFromAllDecks = (deckId: string) =>
		firestore.doc(`users/${this.id}`).update({
			allDecks: FieldValue.arrayRemove(deckId)
		})

	updateAuthDisplayName = (name: string) =>
		auth.updateUser(this.id, { displayName: name })

	normalizeDisplayName = () => this.updateAuthDisplayName(this.name)

	removeAuth = () => auth.deleteUser(this.id)

	didBlockUserWithId = async (id: string) =>
		(await firestore.doc(`users/${this.id}/blocked/${id}`).get()).exists

	getTokens = async () =>
		Object.prototype.hasOwnProperty.call(tokenCache, this.id)
			? tokenCache[this.id]
			: (tokenCache[this.id] = (
					await firestore.collection(`users/${this.id}/tokens`).get()
			  ).docs.map(({ id }) => id))

	notification = async (options: NotificationOptions) =>
		createNotifications(await this.getTokens(), options)

	private createUserData = async () => {
		await firestore.doc(`users/${this.id}`).update({
			...this.getSlug(),
			source: this.source,
			apiKey: this.apiKey,
			allowContact: this.allowContact,
			muted: this.isMuted,
			notifications: DEFAULT_USER_NOTIFICATIONS
		})
	}

	private getSlug = () => {
		if (this.slugId && this.slug) return null

		this.slugId = nanoid(User.SLUG_ID_LENGTH)
		this.slug = slugify(this.name)

		return { slugId: this.slugId, slug: this.slug }
	}

	private createApiKey = async () => {
		firestore.doc(`apiKeys/${this.apiKey}`).set({
			user: this.id,
			requests: 0,
			enabled: true
		})
	}

	private removeApiKey = async () => {
		await firestore.doc(`apiKeys/${this.apiKey}`).delete()
	}

	get json() {
		return {
			id: this.id,
			short_id: this.slugId,
			slug: this.slug,
			has_image: this.hasImage,
			name: this.name,
			interests: this.interests,
			decks: this.numberOfDecks,
			all_decks: this.allDecks
		}
	}

	get emailUser(): EmailUser {
		return {
			name: this.name,
			email: this.email
		}
	}
}
