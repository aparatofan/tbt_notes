<?php
/**
 * Admin (wp-admin) settings page for TBT Notes.
 *
 * Authoring happens in the front-end slide-out panel; this dashboard page is for
 * setup: choosing who can manage notes (which is how you give a non-admin
 * "teacher" account authoring rights) and toggling the floating launcher tab.
 *
 * @package TBT_Notes
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Class TBT_Notes_Admin
 */
class TBT_Notes_Admin {

	const PAGE_SLUG = 'tbt-notes';

	/**
	 * Hook admin menu.
	 */
	public function register() {
		add_action( 'admin_menu', array( $this, 'add_menu' ) );
	}

	/**
	 * Register the top-level menu page.
	 */
	public function add_menu() {
		add_menu_page(
			__( 'TBT Notes', 'tbt-notes' ),
			__( 'TBT Notes', 'tbt-notes' ),
			'manage_options',
			self::PAGE_SLUG,
			array( $this, 'render_page' ),
			'dashicons-welcome-write-blog',
			58
		);
	}

	/**
	 * Render (and handle saving of) the settings page.
	 */
	public function render_page() {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to access this page.', 'tbt-notes' ) );
		}

		$saved = false;
		if ( isset( $_POST['tbt_notes_nonce'] ) && wp_verify_nonce( sanitize_text_field( wp_unslash( $_POST['tbt_notes_nonce'] ) ), 'tbt_notes_save_settings' ) ) {
			$this->save();
			$saved = true;
		}

		$show_launcher = get_option( 'tbt_notes_show_launcher', '1' ) !== '0';
		$manager_roles = (array) get_option( 'tbt_notes_manager_roles', array( 'administrator' ) );
		$all_roles     = wp_roles()->roles;
		?>
		<div class="wrap">
			<h1><?php echo esc_html__( 'TBT Notes', 'tbt-notes' ); ?></h1>

			<?php if ( $saved ) : ?>
				<div class="notice notice-success is-dismissible"><p><?php echo esc_html__( 'Settings saved.', 'tbt-notes' ); ?></p></div>
			<?php endif; ?>

			<p><?php echo esc_html__( 'Teachers create and edit notes in the slide-out panel on the front-end of the site. Use this page to choose who can manage notes and how the panel is opened.', 'tbt-notes' ); ?></p>

			<form method="post" action="">
				<?php wp_nonce_field( 'tbt_notes_save_settings', 'tbt_notes_nonce' ); ?>

				<h2 class="title"><?php echo esc_html__( 'Who can manage notes', 'tbt-notes' ); ?></h2>
				<p class="description"><?php echo esc_html__( 'Selected roles can create classes, assign students and write notes. Administrators can always manage notes.', 'tbt-notes' ); ?></p>
				<table class="form-table" role="presentation">
					<tbody>
						<tr>
							<th scope="row"><?php echo esc_html__( 'Roles', 'tbt-notes' ); ?></th>
							<td>
								<?php foreach ( $all_roles as $slug => $role ) : ?>
									<?php
									$is_admin_role = ( 'administrator' === $slug );
									$checked       = $is_admin_role || in_array( $slug, $manager_roles, true );
									?>
									<label style="display:block;margin-bottom:6px;">
										<input type="checkbox" name="tbt_notes_manager_roles[]" value="<?php echo esc_attr( $slug ); ?>" <?php checked( $checked ); ?> <?php disabled( $is_admin_role ); ?> />
										<?php echo esc_html( translate_user_role( $role['name'] ) ); ?>
										<?php if ( $is_admin_role ) : ?>
											<em>(<?php echo esc_html__( 'always', 'tbt-notes' ); ?>)</em>
										<?php endif; ?>
									</label>
								<?php endforeach; ?>
							</td>
						</tr>
					</tbody>
				</table>

				<h2 class="title"><?php echo esc_html__( 'Opening the panel', 'tbt-notes' ); ?></h2>
				<table class="form-table" role="presentation">
					<tbody>
						<tr>
							<th scope="row"><?php echo esc_html__( 'Floating tab', 'tbt-notes' ); ?></th>
							<td>
								<label>
									<input type="checkbox" name="tbt_notes_show_launcher" value="1" <?php checked( $show_launcher ); ?> />
									<?php echo esc_html__( 'Show the floating "Notes" tab on the left edge of the site', 'tbt-notes' ); ?>
								</label>
								<p class="description">
									<?php echo esc_html__( 'Turn this off if you open Notes from your own menu instead.', 'tbt-notes' ); ?>
								</p>
							</td>
						</tr>
					</tbody>
				</table>

				<?php submit_button(); ?>
			</form>

			<hr />
			<h2 class="title"><?php echo esc_html__( 'Open Notes from your own menu', 'tbt-notes' ); ?></h2>
			<p><?php echo esc_html__( 'Any of these will open the Notes panel when clicked — use whichever your menu/page supports:', 'tbt-notes' ); ?></p>
			<ul style="list-style:disc;margin-left:20px;">
				<li><?php echo esc_html__( 'Shortcode (in a page, widget or block):', 'tbt-notes' ); ?> <code>[tbt_notes label="Notes"]</code></li>
				<li><?php echo esc_html__( 'A menu item / link pointing to:', 'tbt-notes' ); ?> <code>#tbt-notes</code></li>
				<li><?php echo esc_html__( 'Any element with the CSS class:', 'tbt-notes' ); ?> <code>tbt-notes-trigger</code></li>
			</ul>
			<p class="description"><?php echo esc_html__( 'For a WordPress menu, add a Custom Link with the URL #tbt-notes, or add the CSS class tbt-notes-trigger to a menu item (enable “CSS Classes” under Screen Options).', 'tbt-notes' ); ?></p>
		</div>
		<?php
	}

	/**
	 * Persist submitted settings.
	 */
	protected function save() {
		$show_launcher = isset( $_POST['tbt_notes_show_launcher'] ) ? '1' : '0';
		update_option( 'tbt_notes_show_launcher', $show_launcher );

		$selected = isset( $_POST['tbt_notes_manager_roles'] )
			? array_map( 'sanitize_key', (array) wp_unslash( $_POST['tbt_notes_manager_roles'] ) )
			: array();

		// Administrators are always managers; keep the role list meaningful.
		if ( ! in_array( 'administrator', $selected, true ) ) {
			$selected[] = 'administrator';
		}

		update_option( 'tbt_notes_manager_roles', $selected );
		TBT_Notes_Capabilities::sync_role_caps( $selected );
	}
}
